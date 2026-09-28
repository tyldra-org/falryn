import { expect, test } from "bun:test";
import {
  type CuratedCatalog,
  decideCuratedImport,
  ingestCuratedCatalog,
  listingCompatibility,
  parseCuratedCatalog,
  parseCuratedCatalogRecord,
  serializeCuratedCatalog,
} from "./curated-catalog.ts";
import {
  catalogBytes,
  curatedDocument,
  curatedEntry,
  curatedIdentity,
} from "./curated-catalog-fixtures.ts";

const ingest = (value: unknown) => ingestCuratedCatalog(catalogBytes(value));
function accepted(value: unknown) {
  const result = ingest(value);
  if (result.kind !== "ingested") throw new Error(JSON.stringify(result.diagnostics));
  return result;
}
const codes = (value: unknown) =>
  (ingest(value) as { diagnostics: readonly { code: string }[] }).diagnostics.map((d) => d.code);

test("a valid catalog normalizes deterministically and round-trips byte for byte", () => {
  const a = curatedEntry("tools/review", { versions: ["1.0.0", "1.1.0"] });
  const b = curatedEntry("tools/format");
  const first = accepted(curatedDocument([a, b])).catalog;
  // Entry order and key order in the submission do not change the record.
  const second = accepted(curatedDocument([b, a])).catalog;
  expect(serializeCuratedCatalog(second)).toBe(serializeCuratedCatalog(first));
  expect(first.entries.map((entry) => entry.listingId)).toEqual(["tools/format", "tools/review"]);
  expect(first.entries[1]?.versions.map((v) => v.identity.packageVersion)).toEqual([
    "1.1.0",
    "1.0.0",
  ]);
  const text = serializeCuratedCatalog(first);
  expect(serializeCuratedCatalog(parseCuratedCatalog(text))).toBe(text);
  // A changed body no longer matches its digest.
  expect(() => parseCuratedCatalog(text.replace("Review helper", "Review helpers"))).toThrow(
    "catalog-record-corrupt",
  );
});

test("absent, unsupported and claimed-false evidence stay distinct and stay claims", () => {
  const entry = {
    ...curatedEntry("tools/review"),
    claims: {
      review: { value: false, at: 1, by: "Reviewer" },
      signature: "verified",
      "x-audit": { value: true },
    },
  };
  const [listing] = accepted(curatedDocument([entry])).catalog.entries;
  expect(listing?.claims).toEqual({
    authority: "catalog-claim",
    review: { status: "claimed", value: false, at: 1, by: "Reviewer" },
    signature: { status: "unsupported" },
    tests: { status: "absent" },
    unrecognized: ["x-audit"],
  });
});

test("editorial rank and labels change neither identity nor order", () => {
  const low = { ...curatedEntry("tools/a"), editorial: { labels: [], rank: 999, featured: false } };
  const high = {
    ...curatedEntry("tools/b"),
    editorial: { labels: ["trusted", "official"], rank: 0, featured: true },
  };
  const catalog = accepted(curatedDocument([high, low])).catalog;
  expect(catalog.entries.map((entry) => entry.listingId)).toEqual(["tools/a", "tools/b"]);
  const plain = accepted(
    curatedDocument([{ ...high, editorial: { labels: [], rank: null, featured: false } }]),
  ).catalog;
  expect(plain.entries[0]?.versions[0]?.identityDigest).toBe(
    catalog.entries[1]?.versions[0]?.identityDigest,
  );
});

test("document-level problems refuse the whole catalog without echoing values", () => {
  for (const [value, code] of [
    [{ ...curatedDocument([]), schema: "other" }, "catalog-schema-unsupported"],
    [{ ...curatedDocument([]), generation: 2 }, "catalog-generation-unsupported"],
    [{ ...curatedDocument([]), requires: ["signatures-v2"] }, "catalog-required-field-unknown"],
    [{ ...curatedDocument([]), sequence: 0 }, "catalog-header-invalid"],
    [{ ...curatedDocument([]), source: { id: "Bad Id", title: "x" } }, "catalog-header-invalid"],
    [[1, 2], "catalog-malformed"],
  ] as const)
    expect([code, codes(value)]).toEqual([code, [code]]);
  expect(ingestCuratedCatalog(new TextEncoder().encode('{"schema":1,"schema":2}'))).toMatchObject({
    kind: "rejected",
    diagnostics: [{ code: "catalog-duplicate-key" }],
  });
  expect(ingestCuratedCatalog(new Uint8Array([0xff, 0xfe]))).toMatchObject({ kind: "rejected" });
  expect(ingestCuratedCatalog(new Uint8Array(1_048_577))).toMatchObject({
    diagnostics: [{ code: "catalog-too-large" }],
  });
  expect(
    ingest({ ...curatedDocument([]), entries: Array.from({ length: 513 }, () => ({})) }),
  ).toMatchObject({ diagnostics: [{ code: "catalog-entry-limit" }] });
});

test("one bad entry is refused alone, with a field path and no submitted value", () => {
  const secret = "https://user:hunter2@example.test/";
  const bad = [
    { ...curatedEntry("tools/b1"), links: { homepage: secret } },
    { ...curatedEntry("tools/b2"), links: { homepage: "javascript:alert(1)" } },
    { ...curatedEntry("tools/b3"), title: "Safe\u202Eexe.txt" },
    { ...curatedEntry("tools/b4"), requires: ["payments"] },
    { ...curatedEntry("tools/b5"), kind: "binary" },
    { ...curatedEntry("tools/b6"), versions: [] },
    "not an object",
  ];
  const result = accepted(curatedDocument([curatedEntry("tools/good"), ...bad]));
  expect(result.catalog.entries.map((entry) => entry.listingId)).toEqual(["tools/good"]);
  expect(result.rejected).toEqual([
    "tools/b1",
    "tools/b2",
    "tools/b3",
    "tools/b4",
    "tools/b5",
    "tools/b6",
  ]);
  expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
    ["link-invalid", "/entries/1/links/homepage"],
    ["link-invalid", "/entries/2/links/homepage"],
    ["text-deceptive", "/entries/3/title"],
    ["entry-required-field-unknown", "/entries/4/requires"],
    ["field-invalid", "/entries/5/kind"],
    ["field-invalid", "/entries/6/versions"],
    ["entry-malformed", "/entries/7"],
  ]);
  expect(JSON.stringify(result)).not.toContain("hunter2");
});

test("unknown optional fields are ignored and reported, never kept", () => {
  const result = accepted(
    curatedDocument([{ ...curatedEntry("tools/review"), sponsorship: { paid: true } }], {
      extra: { mirror: "https://elsewhere.test" },
    }),
  );
  expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
    ["field-ignored", "/mirror"],
    ["field-ignored", "/entries/0/sponsorship"],
  ]);
  expect(serializeCuratedCatalog(result.catalog)).not.toContain("sponsorship");
  expect(result.rejected).toEqual([]);
});

test("duplicate listings and shared package identities refuse every participant", () => {
  const shared = curatedEntry("tools/one");
  const impostor = {
    ...curatedEntry("tools/two"),
    versions: shared.versions,
    title: "Review helper",
  };
  const duplicate = { ...curatedEntry("tools/dup") };
  const result = accepted(
    curatedDocument([shared, impostor, duplicate, { ...duplicate }, curatedEntry("tools/ok")]),
  );
  expect(result.catalog.entries.map((entry) => entry.listingId)).toEqual(["tools/ok"]);
  expect(result.diagnostics.map((d) => [d.code, d.listingId])).toEqual([
    ["identity-collision", "tools/one"],
    ["identity-collision", "tools/two"],
    ["listing-duplicate", "tools/dup"],
    ["listing-duplicate", "tools/dup"],
  ]);
  // Versions inside one listing must name one package once each.
  const mixed = {
    ...curatedEntry("tools/mixed"),
    versions: [
      { identity: curatedIdentity("pkg-a", "1.0.0"), publishedAt: 1 },
      { identity: curatedIdentity("pkg-b", "1.1.0"), publishedAt: 2 },
    ],
  };
  expect(codes(curatedDocument([mixed]))).toEqual(["versions-inconsistent"]);
});

test("withdrawn and incompatible versions stay listed and say so", () => {
  const entry = curatedEntry("tools/review", { versions: ["1.0.0", "2.0.0"] });
  const versions = entry.versions as Record<string, unknown>[];
  versions[0] = { ...versions[0], withdrawn: { reason: "security", at: 5 } };
  versions[1] = { ...versions[1], compatibility: { os: ["win32"], arch: [] } };
  const [listing] = accepted(curatedDocument([entry])).catalog.entries;
  if (listing === undefined) throw new Error("missing listing");
  expect(
    listingCompatibility(listing, {
      falryn: "0.4.0",
      bun: "1.4.1",
      os: "darwin",
      arch: "arm64",
    }).map((v) => [v.packageVersion, v.compatible, v.withdrawn]),
  ).toEqual([
    ["2.0.0", false, false],
    ["1.0.0", true, true],
  ]);
});

test("imports replace only forward, and a refused entry keeps its earlier listing", () => {
  const first = accepted(
    curatedDocument([curatedEntry("tools/keep"), curatedEntry("tools/gone")]),
  ).catalog;
  const initial = decideCuratedImport(null, first, [], 10);
  if (initial.kind !== "replace") throw new Error(initial.kind);
  const prior = initial.record;
  expect(decideCuratedImport(prior, first, [], 11)).toMatchObject({ kind: "unchanged" });
  const edited = accepted(curatedDocument([curatedEntry("tools/keep")])).catalog;
  expect(decideCuratedImport(prior, edited, [], 11)).toMatchObject({
    kind: "conflict",
    storedSequence: 1,
  });
  expect(
    decideCuratedImport(prior, { ...first, sequence: 0 } as CuratedCatalog, [], 11),
  ).toMatchObject({ kind: "stale" });
  // Sequence 2: tools/keep is now invalid, tools/gone was withdrawn from the catalog.
  const next = ingest(
    curatedDocument([{ ...curatedEntry("tools/keep"), title: "" }, curatedEntry("tools/new")], {
      sequence: 2,
    }),
  );
  if (next.kind !== "ingested") throw new Error("expected ingestion");
  const decided = decideCuratedImport(prior, next.catalog, next.rejected, 12);
  if (decided.kind !== "replace") throw new Error(decided.kind);
  expect(decided.record.catalog.entries.map((e) => e.listingId)).toEqual(["tools/new"]);
  expect(
    decided.record.retained.map((item) => [item.listing.listingId, item.fromSequence]),
  ).toEqual([["tools/keep", 1]]);
  // A retained listing whose package a newer entry now lists is dropped, never duplicated.
  const reclaimed = ingest(
    curatedDocument(
      [
        { ...curatedEntry("tools/keep"), title: "" },
        { ...curatedEntry("tools/renamed", { packageId: "tools-keep" }), title: "Renamed" },
      ],
      { sequence: 3 },
    ),
  );
  if (reclaimed.kind !== "ingested") throw new Error("expected ingestion");
  expect(
    decideCuratedImport(decided.record, reclaimed.catalog, reclaimed.rejected, 13),
  ).toMatchObject({
    kind: "replace",
    dropped: ["tools/keep"],
    record: { retained: [] },
  });
});

test("stored records with an unknown version or changed body are reported, not guessed", () => {
  const catalog = accepted(curatedDocument([curatedEntry("tools/keep")])).catalog;
  const decided = decideCuratedImport(null, catalog, [], 1);
  if (decided.kind !== "replace") throw new Error(decided.kind);
  const text = JSON.stringify(decided.record);
  expect(parseCuratedCatalogRecord(text)).toMatchObject({ ok: true });
  expect(parseCuratedCatalogRecord(text.replace('"recordVersion":1', '"recordVersion":2'))).toEqual(
    {
      ok: false,
      code: "catalog-record-unsupported",
    },
  );
  expect(parseCuratedCatalogRecord(text.replace("Review helper", "Evil helper"))).toEqual({
    ok: false,
    code: "catalog-record-corrupt",
  });
  expect(parseCuratedCatalogRecord("{")).toEqual({ ok: false, code: "catalog-record-corrupt" });
});
