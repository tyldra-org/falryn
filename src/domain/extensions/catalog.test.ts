import { describe, expect, test } from "bun:test";
import { bytesDigest, canonicalDigest } from "./canonical.ts";
import {
  CATALOG_LIMITS,
  type CatalogEntry,
  catalogEntryKey,
  catalogEntrySchema,
  createExtensionCatalog,
  queryExtensionCatalog,
} from "./catalog.ts";
import { boundCatalogFixture, catalogFixture } from "./catalog-fixtures.ts";

function catalog(entries: readonly unknown[], generation = 1, inputs = bytesDigest("inputs")) {
  return createExtensionCatalog({ entries, generation, inputs });
}

describe("compact extension catalogs", () => {
  test("preserves package, builtin and standalone owner identities without synthetic layers", () => {
    const standalone: CatalogEntry = {
      ...catalogFixture("standalone"),
      source: {
        kind: "standalone",
        owner: {
          version: 1,
          kind: "skill",
          sourceCoordinate: {
            kind: "local",
            rootId: bytesDigest("root"),
            path: "skill",
            sourceDigest: bytesDigest("skill"),
          },
          contentDigest: bytesDigest("skill"),
          provenanceDigest: bytesDigest("provenance"),
          scope: "session",
          scopeAuthorityId: "session-1",
          scopeAuthorityGeneration: 1,
          catalogGeneration: 1,
        },
      },
    };
    standalone.contribution = {
      ...standalone.contribution,
      owner: { kind: "standalone", digest: canonicalDigest(standalone.source.owner) },
    };
    const entries = [catalogFixture(), catalogFixture("builtin", "builtin"), standalone];
    const result = catalog(entries);
    expect(result.entries).toHaveLength(3);
    for (const original of entries) {
      expect(
        result.entries.find((entry) => catalogEntryKey(entry) === catalogEntryKey(original)),
      ).toEqual(original);
    }
    expect(
      result.entries.find((entry) => entry.source.kind === "standalone")?.source,
    ).not.toHaveProperty("activation");
    expect(() =>
      catalog([
        { ...standalone, contribution: { ...standalone.contribution, nativeKind: "prompt" } },
      ]),
    ).toThrow("invalid-catalog-entry");
  });

  test("normalizes metadata, sorts deterministically, and freezes a detached snapshot", () => {
    const entry = catalogFixture();
    const other = catalogFixture("other");
    const snapshot = catalog([entry, other]);
    expect(snapshot.identity).toBe(catalog([other, entry]).identity);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.entries[0]?.source.owner)).toBe(true);
    entry.aliases.push("later");
    expect(snapshot.entries.some((item) => item.aliases.includes("later"))).toBe(false);
    expect(catalog([entry, other]).identity).not.toBe(snapshot.identity);
  });

  test("rejects duplicate identities, forged links, arbitrary bodies and inferred availability", () => {
    const entry = catalogFixture();
    expect(() => catalog([entry, entry])).toThrow("duplicate-catalog-identity");
    const invalid: unknown[] = [
      { ...entry, instructions: "private instructions" },
      { ...entry, schema: { type: "object" } },
      { ...entry, availability: "available" },
      {
        ...entry,
        contribution: {
          ...entry.contribution,
          owner: { kind: "package", digest: bytesDigest("wrong") },
        },
      },
      { ...entry, aliases: ["same", "same"] },
      { ...entry, aliases: ["e\u0301", "é"] },
      { ...entry, aliases: Array.from({ length: 17 }, (_, i) => `alias-${i}`) },
      { ...boundCatalogFixture("native"), enabled: false },
      { ...boundCatalogFixture("native"), trust: "revoked" },
      { ...boundCatalogFixture("native"), lifecycle: "historical" },
      { ...boundCatalogFixture("native"), family: "run" },
      { ...boundCatalogFixture("native"), family: null },
    ];
    for (const value of invalid) expect(() => catalog([value])).toThrow("invalid-catalog-entry");
    if (entry.source.kind !== "package") throw new Error("fixture-owner");
    expect(
      catalogEntrySchema.safeParse({
        ...entry,
        source: {
          ...entry.source,
          activation: { ...entry.source.activation, packageIdentityDigest: bytesDigest("wrong") },
        },
      }).success,
    ).toBe(false);
  });

  test("retains native kinds within a mixed package without collapsing aliases", () => {
    const skill = catalogFixture();
    const mcp: CatalogEntry = {
      ...skill,
      contribution: { ...skill.contribution, nativeKind: "mcp-server", localId: "server" },
    };
    const snapshot = catalog([skill, mcp]);
    expect(snapshot.entries).toHaveLength(2);
    expect(
      queryExtensionCatalog(snapshot, {
        catalog: snapshot.identity,
        filter: { nativeKind: "mcp-server" },
      }).entries,
    ).toEqual([mcp]);
  });

  test("bounds count, aggregate UTF-8 metadata, cancellation and deadline without returning an empty success", () => {
    expect(() => catalog(Array.from({ length: CATALOG_LIMITS.descriptors + 1 }))).toThrow(
      "catalog-descriptor-limit",
    );
    const large = Array.from({ length: 1_400 }, (_, i) => ({
      ...catalogFixture(`large-${i}`),
      aliases: Array.from({ length: 16 }, (_, n) => `${n}${"界".repeat(250)}`),
    }));
    expect(() => catalog(large)).toThrow("catalog-metadata-limit");
    expect(() =>
      createExtensionCatalog({
        entries: [],
        generation: 1,
        inputs: bytesDigest("inputs"),
        signal: AbortSignal.abort(),
      }),
    ).toThrow("cancelled");
    let now = 0;
    expect(() =>
      createExtensionCatalog({
        entries: [catalogFixture()],
        generation: 1,
        inputs: bytesDigest("inputs"),
        now: () => {
          now += 30_000;
          return now;
        },
      }),
    ).toThrow("catalog-deadline");
  });
});

describe("generation-bound catalog queries", () => {
  test("paginates at 32 by default and rejects excessive pages and mismatched filters", () => {
    const snapshot = catalog(Array.from({ length: 35 }, (_, i) => catalogFixture(`package-${i}`)));
    const first = queryExtensionCatalog(snapshot, { catalog: snapshot.identity });
    expect(first.entries).toHaveLength(32);
    expect(first.total).toBe(35);
    expect(first.omitted).toBe(3);
    expect(first.next).not.toBeNull();
    const last = queryExtensionCatalog(snapshot, {
      catalog: snapshot.identity,
      handle: first.next,
    });
    expect(last.entries).toHaveLength(3);
    expect(last.next).toBeNull();
    expect(new Set([...first.entries, ...last.entries].map(catalogEntryKey)).size).toBe(35);
    expect(() =>
      queryExtensionCatalog(snapshot, { catalog: snapshot.identity, limit: 257 }),
    ).toThrow();
    expect(() =>
      queryExtensionCatalog(snapshot, {
        catalog: snapshot.identity,
        handle: first.next,
        filter: { scope: "user" },
      }),
    ).toThrow("stale-catalog-handle");
  });

  test("filters by each exact semantic field", () => {
    const entry = catalogFixture();
    const snapshot = catalog([entry, catalogFixture("other", "session")]);
    for (const filter of [
      { owner: entry.contribution.owner.digest },
      { contribution: canonicalDigest(entry.contribution) },
      { scope: "user" },
      { package: canonicalDigest(entry.source.owner) },
    ])
      expect(
        queryExtensionCatalog(snapshot, { catalog: snapshot.identity, filter }).entries,
      ).toEqual([entry]);
    for (const filter of [
      { nativeKind: "tool" },
      { family: "run" },
      { compatibility: "incompatible" },
      { lifecycle: "missing" },
    ])
      expect(queryExtensionCatalog(snapshot, { catalog: snapshot.identity, filter }).total).toBe(0);
  });

  test("invalidates handles on input, generation and metadata changes while preserving old snapshots", () => {
    const entry = catalogFixture();
    const before = catalog([entry]);
    const request = { catalog: before.identity };
    for (const replacement of [
      catalog([entry], 2),
      catalog([entry], 1, bytesDigest("revoked")),
      catalog([{ ...entry, enabled: false }]),
    ])
      expect(() => queryExtensionCatalog(replacement, request)).toThrow("stale-catalog-handle");
    expect(queryExtensionCatalog(before, request).entries[0]?.enabled).toBe(true);
  });
});
