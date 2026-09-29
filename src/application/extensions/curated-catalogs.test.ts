import { expect, test } from "bun:test";
import type {
  CuratedCatalogStore,
  StoredCuratedCatalog,
} from "../../domain/extensions/curated-catalog.ts";
import {
  catalogBytes,
  curatedDocument,
  curatedEntry,
} from "../../domain/extensions/curated-catalog-fixtures.ts";
import {
  type MarketplaceSource,
  marketplaceSourceSchema,
} from "../../domain/extensions/marketplace.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { createCuratedCatalogs, curatedListQuerySchema } from "./curated-catalogs.ts";
import type { MarketplaceFetch } from "./marketplace-port.ts";

const HOUR = 3_600_000;
const HOST = { falryn: "1.0.0", bun: "1.3.0", os: "darwin", arch: "arm64" };

/** A compare-and-replace store with a write counter, so tests can prove zero writes. */
function memoryStore() {
  const rows = new Map<string, StoredCuratedCatalog>();
  let writes = 0;
  const store: CuratedCatalogStore = {
    get: (sourceId) => ok(rows.get(sourceId) ?? null),
    list: () => ok([...rows.values()].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1))),
    replace(record, expectedSequence) {
      const id = record.catalog.source.id;
      if ((rows.get(id)?.sequence ?? null) !== expectedSequence)
        return err({ code: "catalog-store-conflict" });
      writes += 1;
      rows.set(id, { sourceId: id, sequence: record.catalog.sequence, record, code: null });
      return ok(null);
    },
  };
  return { store, writes: () => writes };
}

const market = (id: string, value: Record<string, unknown> = {}): MarketplaceSource =>
  marketplaceSourceSchema.parse({
    id,
    url: `https://${id}.example.test/catalog.json`,
    ...value,
  });

function harness(sources: MarketplaceSource[] | null) {
  let now = 10 * HOUR;
  const documents = new Map<string, unknown>();
  const failures = new Map<string, MarketplaceFetch>();
  const fetched: string[] = [];
  const memory = memoryStore();
  const catalogs = createCuratedCatalogs({
    store: memory.store,
    now: () => now,
    host: HOST,
    marketplaces: () => sources,
    fetch: {
      async fetch(source) {
        fetched.push(source.id);
        const failure = failures.get(source.id);
        if (failure) return failure;
        return { kind: "received", bytes: catalogBytes(documents.get(source.id)), fetchedAt: now };
      },
    },
  });
  return {
    catalogs,
    documents,
    failures,
    fetched,
    writes: memory.writes,
    advance: (hours: number) => {
      now += hours * HOUR;
    },
    list: (query: Record<string, unknown> = {}) =>
      catalogs.list(curatedListQuerySchema.parse(query)),
    refresh: (id: string | null = null, signal = new AbortController().signal) =>
      catalogs.refresh(id, signal),
  };
}

test("refresh ingests each marketplace with dated provenance; one failure leaves the rest", async () => {
  const h = harness([market("alpha"), market("beta"), market("off", { enabled: false })]);
  h.documents.set("alpha", curatedDocument([curatedEntry("tools/review")], { source: "alpha" }));
  h.failures.set("beta", { kind: "failed", code: "marketplace-transport-failed" });
  const report = await h.refresh();
  expect(h.fetched).toEqual(["alpha", "beta"]);
  expect(report).toMatchObject({
    status: "refreshed",
    results: [
      { sourceId: "alpha", fetchedAt: 10 * HOUR, receipt: { status: "imported", accepted: 1 } },
      {
        sourceId: "beta",
        fetchedAt: null,
        receipt: { status: "failed", code: "marketplace-transport-failed" },
      },
    ],
  });
  const listed = h.list();
  expect(listed).toMatchObject({
    status: "listed",
    sources: [
      {
        id: "alpha",
        origin: {
          kind: "marketplace",
          url: "https://alpha.example.test/catalog.json",
          fetchedAt: 10 * HOUR,
        },
        freshness: { state: "fresh", fetchedAt: 10 * HOUR },
      },
    ],
    total: 1,
  });
  expect(await h.refresh("off")).toMatchObject({
    results: [{ sourceId: "off", receipt: { code: "marketplace-disabled" } }],
  });
  expect(await h.refresh("missing")).toEqual({ status: "failed", code: "marketplace-unknown" });
  expect(await harness(null).refresh()).toEqual({
    status: "failed",
    code: "marketplace-configuration-unavailable",
  });
});

test("a marketplace cannot publish another source, roll back, or rewrite its sequence", async () => {
  const h = harness([market("alpha")]);
  h.documents.set("alpha", curatedDocument([curatedEntry("tools/review")], { source: "beta" }));
  expect(await h.refresh()).toMatchObject({
    results: [{ receipt: { status: "rejected", code: "marketplace-source-mismatch" } }],
  });
  expect(h.writes()).toBe(0);
  h.documents.set(
    "alpha",
    curatedDocument([curatedEntry("tools/review")], { source: "alpha", sequence: 3 }),
  );
  await h.refresh();
  h.documents.set(
    "alpha",
    curatedDocument([curatedEntry("tools/other")], { source: "alpha", sequence: 2 }),
  );
  expect(await h.refresh()).toMatchObject({
    results: [{ receipt: { status: "rejected", code: "catalog-stale", storedSequence: 3 } }],
  });
  h.documents.set(
    "alpha",
    curatedDocument([curatedEntry("tools/other")], { source: "alpha", sequence: 3 }),
  );
  expect(await h.refresh()).toMatchObject({
    results: [{ receipt: { status: "rejected", code: "catalog-sequence-conflict" } }],
  });
  expect(h.writes()).toBe(1);
});

test("offline listings stay dated: stale until the same catalog is fetched again", async () => {
  const h = harness([market("alpha", { maxAgeHours: 2 })]);
  h.documents.set("alpha", curatedDocument([curatedEntry("tools/review")], { source: "alpha" }));
  await h.refresh();
  h.advance(3);
  expect(h.list()).toMatchObject({
    sources: [{ freshness: { state: "stale", fetchedAt: 10 * HOUR } }],
  });
  // A stale catalog still inspects, but cannot vouch for an install until refreshed.
  expect(h.catalogs.inspect({ sourceId: "alpha", listingId: "tools/review" })).toMatchObject({
    status: "inspected",
    install: { status: "refused", code: "source-not-current" },
  });
  // An unavailable marketplace changes nothing: the cache stays, still stale.
  h.failures.set("alpha", { kind: "failed", code: "marketplace-destination-unresolved" });
  await h.refresh();
  expect(h.list()).toMatchObject({ total: 1, sources: [{ freshness: { state: "stale" } }] });
  h.failures.clear();
  expect(await h.refresh()).toMatchObject({ results: [{ receipt: { status: "unchanged" } }] });
  expect(h.list()).toMatchObject({
    sources: [{ freshness: { state: "fresh", fetchedAt: 13 * HOUR } }],
  });
  expect(h.writes()).toBe(2);
});

test("cancelling a refresh fetches and writes nothing", async () => {
  const h = harness([market("alpha")]);
  h.documents.set("alpha", curatedDocument([curatedEntry("tools/review")], { source: "alpha" }));
  const controller = new AbortController();
  controller.abort();
  expect(await h.refresh(null, controller.signal)).toMatchObject({
    results: [{ receipt: { status: "failed", code: "marketplace-cancelled" } }],
  });
  expect(h.fetched).toEqual([]);
  expect(h.writes()).toBe(0);
});

test("search ranks by where the text matched and never by editorial rank", async () => {
  const h = harness([market("alpha"), market("beta")]);
  const entry = (id: string, title: string, rank: number, extra: Record<string, unknown> = {}) => ({
    ...curatedEntry(id),
    title,
    editorial: { labels: [], rank, featured: rank === 0 },
    ...extra,
  });
  h.documents.set(
    "alpha",
    curatedDocument(
      [
        entry("tools/lint", "Lint helper", 0, { summary: "Mentions review in passing." }),
        entry("tools/review", "Review helper", 999),
        entry("tools/theme", "Night theme", 0, {
          kind: "theme",
          provides: ["theme"],
          tags: ["dark"],
          summary: "Dark colors for the terminal.",
        }),
      ],
      { source: "alpha" },
    ),
  );
  h.documents.set(
    "beta",
    curatedDocument([entry("mirror/reviewer", "Reviewer", 0, { tags: ["review"] })], {
      source: "beta",
    }),
  );
  await h.refresh();
  const order = (query: Record<string, unknown>) => {
    const page = h.list(query);
    if (page.status !== "listed") throw new Error(page.code);
    return page.entries.map((view) => `${view.sourceId}:${view.listing.listingId}`);
  };
  expect(order({ text: "review" })).toEqual([
    "alpha:tools/review",
    "beta:mirror/reviewer",
    "alpha:tools/lint",
  ]);
  expect(order({ text: "review" })).toEqual(order({ text: "REVIEW" }));
  expect(order({ provides: "theme" })).toEqual(["alpha:tools/theme"]);
  expect(order({ kind: "theme", text: "dark" })).toEqual(["alpha:tools/theme"]);
  expect(order({ text: "review", limit: 1, offset: 1 })).toEqual(["beta:mirror/reviewer"]);
});

test("inspect shows one exact version and routes install through a local package", async () => {
  const h = harness([market("alpha")]);
  const listing = {
    ...curatedEntry("tools/review", { versions: ["1.0.0", "2.0.0", "3.0.0"] }),
  } as { versions: Record<string, unknown>[] } & Record<string, unknown>;
  listing.versions[1] = { ...listing.versions[1], withdrawn: { reason: "security", at: 1_500 } };
  listing.versions[2] = { ...listing.versions[2], compatibility: { os: ["win32"], arch: [] } };
  h.documents.set("alpha", curatedDocument([listing], { source: "alpha" }));
  await h.refresh();
  const inspect = (packageVersion?: string) =>
    h.catalogs.inspect({
      sourceId: "alpha",
      listingId: "tools/review",
      ...(packageVersion === undefined ? {} : { packageVersion }),
    });
  const chosen = inspect();
  expect(chosen).toMatchObject({
    status: "inspected",
    source: { freshness: { state: "fresh" } },
    version: { identity: { packageVersion: "1.0.0" }, compatible: true, withdrawn: null },
    executableProfile: "unknown-until-local-inspection",
    install: { status: "unavailable", code: "marketplace-acquisition-unavailable" },
    view: { listing: { claims: { authority: "catalog-claim" } } },
  });
  if (chosen.status !== "inspected" || chosen.install.status !== "unavailable") throw new Error();
  expect(chosen.install.identityDigest).toBe(chosen.version.identityDigest);
  expect(inspect("2.0.0")).toMatchObject({
    install: { status: "refused", code: "version-withdrawn" },
  });
  expect(inspect("3.0.0")).toMatchObject({
    install: { status: "refused", code: "version-incompatible" },
  });
  expect(inspect("9.9.9")).toEqual({ status: "not-found", code: "version-not-found" });

  // A later catalog withdraws the version: the earlier facts are not reused.
  const revoked = {
    ...listing,
    versions: listing.versions.map((v) => ({ ...v, withdrawn: { reason: "security", at: 1_600 } })),
  };
  h.documents.set("alpha", curatedDocument([revoked], { source: "alpha", sequence: 2 }));
  await h.refresh();
  expect(inspect("1.0.0")).toMatchObject({
    install: { status: "refused", code: "version-withdrawn" },
  });
  expect(h.list({ installable: true })).toMatchObject({ total: 0 });
  // Dropping the listing removes it; nothing keeps offering the old identity.
  h.documents.set("alpha", curatedDocument([], { source: "alpha", sequence: 3 }));
  await h.refresh();
  expect(inspect()).toEqual({ status: "not-found", code: "listing-not-found" });
});

test("a disabled marketplace's listings are withheld; reading writes nothing", async () => {
  const sources = [market("alpha")];
  const h = harness(sources);
  h.documents.set("alpha", curatedDocument([curatedEntry("tools/review")], { source: "alpha" }));
  await h.refresh();
  const writes = h.writes();
  sources[0] = market("alpha", { enabled: false });
  expect(h.list()).toMatchObject({ total: 0, sources: [{ freshness: { state: "disabled" } }] });
  expect(h.catalogs.inspect({ sourceId: "alpha", listingId: "tools/review" })).toEqual({
    status: "not-found",
    code: "listing-source-disabled",
  });
  expect(h.writes()).toBe(writes);
});
