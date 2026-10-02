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
import type { PackageSuggestionPreferences } from "../../domain/extensions/package-suggestion.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { createCuratedCatalogs } from "./curated-catalogs.ts";
import {
  createPackageSuggestionResolver,
  createPackageSuggestionSession,
} from "./package-suggestions.ts";

const HOUR = 3_600_000;
const HOST = { falryn: "1.0.0", bun: "1.3.0", os: "darwin", arch: "arm64" };
const bytes = (text: string) => new TextEncoder().encode(text);
const marker = (value: Record<string, unknown>) =>
  bytes(`warning: no lint rules\nfalryn-package-hint/1 ${JSON.stringify(value)}\n`);
const LINT_HINT = { sourceId: "market", listingId: "tools/lint", packageId: "tools-lint" };
const lintEntry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...curatedEntry("tools/lint", { versions: ["1.0.0", "1.1.0"] }),
  title: "Lint rules",
  relevance: { executables: ["eslint"], files: ["*.lint.json"] },
  ...extra,
});

function memoryStore() {
  const rows = new Map<string, StoredCuratedCatalog>();
  const store: CuratedCatalogStore = {
    get: (sourceId) => ok(rows.get(sourceId) ?? null),
    list: () => ok([...rows.values()].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1))),
    replace(record, expectedSequence) {
      const id = record.catalog.source.id;
      if ((rows.get(id)?.sequence ?? null) !== expectedSequence)
        return err({ code: "catalog-store-conflict" });
      rows.set(id, { sourceId: id, sequence: record.catalog.sequence, record, code: null });
      return ok(null);
    },
  };
  return store;
}

const market = (id: string, value: Record<string, unknown> = {}): MarketplaceSource =>
  marketplaceSourceSchema.parse({ id, url: `https://${id}.example.test/catalog.json`, ...value });

function harness(options: { readonly sources?: MarketplaceSource[] } = {}) {
  let now = 10 * HOUR;
  let sources: MarketplaceSource[] | null = options.sources ?? [market("market"), market("other")];
  let preferences: PackageSuggestionPreferences | null = {
    sources: ["market"],
    dismissed: [],
  };
  const documents = new Map<string, unknown>();
  const catalogs = createCuratedCatalogs({
    store: memoryStore(),
    now: () => now,
    host: HOST,
    marketplaces: () => sources,
    fetch: {
      async fetch(source) {
        return { kind: "received", bytes: catalogBytes(documents.get(source.id)), fetchedAt: now };
      },
    },
  });
  const resolver = createPackageSuggestionResolver({
    catalogs,
    preferences: () => preferences,
    marketplaces: () => sources,
  });
  return {
    catalogs,
    resolver,
    session: createPackageSuggestionSession(() => resolver),
    publish: async (sourceId: string, entries: unknown[], sequence = 1) => {
      documents.set(sourceId, curatedDocument(entries, { source: sourceId, sequence }));
      const refreshed = await catalogs.refresh(sourceId, new AbortController().signal);
      if (refreshed.status !== "refreshed") throw new Error("refresh failed");
    },
    advance: (hours: number) => {
      now += hours * HOUR;
    },
    setPreferences: (value: PackageSuggestionPreferences | null) => {
      preferences = value;
    },
    setSources: (value: MarketplaceSource[] | null) => {
      sources = value;
    },
  };
}

test("a command hint and a relevance declaration converge on one verified suggestion", async () => {
  const h = harness();
  await h.publish("market", [lintEntry()]);
  h.session.observeCommand({
    stderr: marker(LINT_HINT),
    executablePath: "/usr/local/bin/eslint",
    invocationId: "invocation-1",
  });
  h.session.observePaths(["app/.eslintrc.lint.json"]);

  const page = h.session.list();
  if (page.status !== "resolved") throw new Error("expected resolution");
  expect(page.refusals).toEqual([]);
  expect(page.suggestions).toHaveLength(1);
  const [suggestion] = page.suggestions;
  expect(suggestion).toMatchObject({
    sourceId: "market",
    listingId: "tools/lint",
    packageId: "tools-lint",
    title: "Lint rules",
    version: { packageVersion: "1.1.0" },
    freshness: { state: "fresh" },
    install: { status: "available" },
    state: "suggested",
    handoff: { listing: { sourceId: "market", listingId: "tools/lint", packageVersion: "1.1.0" } },
  });
  expect(suggestion?.reasons).toEqual([
    { kind: "hint", executable: "eslint", invocationId: "invocation-1" },
    { kind: "relevance", signal: "executable", rule: "eslint" },
    { kind: "relevance", signal: "file", rule: "*.lint.json" },
  ]);

  // One unsolicited suggestion per settled root turn, and only once per session.
  expect(h.session.settleRootTurn()).toMatchObject({
    version: 1,
    surfaced: { listingId: "tools/lint", packageVersion: "1.1.0" },
    additional: [],
  });
  expect(h.session.settleRootTurn()).toBeNull();
});

test("an exact hinted version is inspected as named; duplicate output adds nothing", async () => {
  const h = harness();
  await h.publish("market", [lintEntry()]);
  for (const invocationId of ["invocation-1", "invocation-2"])
    h.session.observeCommand({
      stderr: marker({ ...LINT_HINT, packageVersion: "1.0.0" }),
      executablePath: null,
      invocationId,
    });
  const page = h.session.list();
  if (page.status !== "resolved") throw new Error("expected resolution");
  expect(page.suggestions).toHaveLength(1);
  expect(page.suggestions[0]?.version?.packageVersion).toBe("1.0.0");
  // The second command repeated the same hint, so only the first invocation is a reason.
  expect(page.suggestions[0]?.reasons).toEqual([
    { kind: "hint", executable: null, invocationId: "invocation-1" },
  ]);
});

test("spoofed, unknown and un-opted sources yield refusals and no installable suggestion", async () => {
  const h = harness();
  await h.publish("market", [lintEntry(), curatedEntry("tools/other")]);
  await h.publish("other", [lintEntry()]);
  for (const [index, hint] of [
    { ...LINT_HINT, packageId: "attacker-package" },
    { ...LINT_HINT, sourceId: "other" },
    { ...LINT_HINT, sourceId: "nowhere" },
    { ...LINT_HINT, listingId: "tools/missing" },
    { ...LINT_HINT, packageVersion: "9.9.9" },
  ].entries())
    h.session.observeCommand({
      stderr: marker(hint),
      executablePath: null,
      invocationId: `invocation-${index}`,
    });
  const page = h.session.list();
  expect(page).toEqual({
    status: "resolved",
    suggestions: [],
    refusals: [
      expect.objectContaining({ code: "suggestion-identity-mismatch" }),
      expect.objectContaining({ code: "suggestion-source-not-enabled", sourceId: "other" }),
      expect.objectContaining({ code: "suggestion-source-not-enabled", sourceId: "nowhere" }),
      expect.objectContaining({ code: "listing-not-found" }),
      expect.objectContaining({ code: "version-not-found" }),
    ],
  });
  expect(h.session.settleRootTurn()).toBeNull();
});

test("a local file import is never an authenticated suggestion source", async () => {
  const h = harness();
  h.catalogs.import(catalogBytes(curatedDocument([lintEntry()], { source: "market" })));
  h.session.observeCommand({
    stderr: marker(LINT_HINT),
    executablePath: "/usr/bin/eslint",
    invocationId: "invocation-1",
  });
  expect(h.session.list()).toEqual({
    status: "resolved",
    suggestions: [],
    refusals: [expect.objectContaining({ code: "suggestion-source-unauthenticated" })],
  });
});

test("a stale catalog is listed with its freshness but never offers or surfaces an install", async () => {
  const h = harness();
  await h.publish("market", [lintEntry()]);
  h.advance(48);
  h.session.observeCommand({
    stderr: marker(LINT_HINT),
    executablePath: null,
    invocationId: "invocation-1",
  });
  const page = h.session.list();
  if (page.status !== "resolved") throw new Error("expected resolution");
  expect(page.suggestions[0]).toMatchObject({
    freshness: { state: "stale" },
    install: { status: "refused", code: "source-not-current" },
    handoff: null,
  });
  expect(h.session.settleRootTurn()).toBeNull();
});

test("withdrawal, removal, disabling and opting out each remove eligibility at the next read", async () => {
  const h = harness();
  await h.publish("market", [lintEntry()]);
  h.session.observePaths(["a.lint.json"]);
  const installable = () => {
    const page = h.session.list();
    return page.status === "resolved" ? page.suggestions.map((item) => item.install.status) : null;
  };
  expect(installable()).toEqual(["available"]);

  await h.publish(
    "market",
    [
      lintEntry({
        versions: (lintEntry().versions as Record<string, unknown>[]).map((version) => ({
          ...version,
          withdrawn: { reason: "security", at: 5_000 },
        })),
      }),
    ],
    2,
  );
  expect(installable()).toEqual(["refused"]);

  await h.publish("market", [curatedEntry("tools/other")], 3);
  expect(installable()).toEqual([]);

  await h.publish("market", [lintEntry()], 4);
  expect(installable()).toEqual(["available"]);
  h.setSources([market("market", { enabled: false })]);
  expect(installable()).toEqual([]);

  h.setSources([market("market")]);
  h.setPreferences({ sources: [], dismissed: [] });
  expect(installable()).toEqual([]);

  h.setPreferences(null);
  expect(h.session.list()).toEqual({
    status: "failed",
    code: "suggestion-preferences-unavailable",
  });
  expect(h.session.settleRootTurn()).toBeNull();
});

test("a dismissal survives a package update and refuses the install handoff", async () => {
  const h = harness();
  await h.publish("market", [lintEntry()]);
  h.setPreferences({
    sources: ["market"],
    dismissed: [{ sourceId: "market", packageId: "tools-lint" }],
  });
  h.session.observePaths(["a.lint.json"]);
  await h.publish("market", [lintEntry({ versions: lintEntry().versions })], 2);
  const page = h.session.list();
  if (page.status !== "resolved") throw new Error("expected resolution");
  expect(page.suggestions[0]).toMatchObject({
    state: "dismissed",
    install: { status: "refused", code: "suggestion-dismissed" },
    handoff: null,
  });
  expect(h.session.settleRootTurn()).toBeNull();
});

test("additional matches are recorded beside the surfaced one and surface on later turns", async () => {
  const h = harness();
  await h.publish("market", [
    lintEntry(),
    { ...curatedEntry("tools/format"), relevance: { executables: ["prettier"] } },
  ]);
  h.session.observeCommand({
    stderr: new Uint8Array(),
    executablePath: "/usr/bin/eslint",
    invocationId: "invocation-1",
  });
  h.session.observeCommand({
    stderr: new Uint8Array(),
    executablePath: "/usr/bin/prettier",
    invocationId: "invocation-2",
  });
  const first = h.session.settleRootTurn();
  expect(first?.surfaced.listingId).toBe("tools/format");
  expect(first?.additional.map((item) => item.listingId)).toEqual(["tools/lint"]);
  expect(h.session.settleRootTurn()?.surfaced.listingId).toBe("tools/lint");
  expect(h.session.settleRootTurn()).toBeNull();
});

test("a session keeps a bounded number of observations and counts the rest", () => {
  const h = harness();
  h.session.observePaths(Array.from({ length: 200 }, (_, index) => `file-${index}.ts`));
  h.session.observePaths(["/etc/passwd", ""]);
  expect(h.session.observations()).toHaveLength(128);
  expect(h.session.omitted()).toBe(72);
});
