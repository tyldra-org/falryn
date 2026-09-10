import { describe, expect, test } from "bun:test";
import { bytesDigest, canonicalDigest } from "./canonical.ts";
import {
  CATALOG_SCOPES,
  type CatalogEntry,
  catalogEntryKey,
  createExtensionCatalog,
} from "./catalog.ts";
import { boundCatalogFixture, catalogFixture } from "./catalog-fixtures.ts";
import { resolveExtensionCatalog } from "./catalog-resolution.ts";

function catalog(entries: readonly CatalogEntry[]) {
  return createExtensionCatalog({ entries, generation: 1, inputs: bytesDigest("inputs") });
}

describe("catalog choice resolution", () => {
  test("resolves exact identities before aliases, including disabled explicit-only entries", () => {
    const exact = { ...catalogFixture("exact"), enabled: false, explicitOnly: true };
    const shadow = catalogFixture("shadow", "development");
    const snapshot = catalog([exact, shadow]);
    for (const identity of [catalogEntryKey(exact), canonicalDigest(exact.contribution)]) {
      const result = resolveExtensionCatalog(snapshot, {
        catalog: snapshot.identity,
        target: { kind: "exact", identity },
      });
      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") throw new Error("resolution");
      expect(result.entry).toEqual(exact);
      expect(result.entry.availability).toBe("unavailable");
    }
    expect(
      resolveExtensionCatalog(snapshot, {
        catalog: snapshot.identity,
        target: { kind: "exact", identity: bytesDigest("missing") },
      }).status,
    ).toBe("missing");
  });

  test("retains all owners and uses development/process/session/workspace/user/builtin precedence", () => {
    const entries = CATALOG_SCOPES.map((scope) => catalogFixture(scope, scope));
    const order = ["development", "process", "session", "workspace", "user", "builtin"];
    for (const expected of order) {
      const snapshot = catalog(entries);
      const result = resolveExtensionCatalog(snapshot, {
        catalog: snapshot.identity,
        target: { kind: "alias", name: "shared" },
      });
      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") throw new Error("resolution");
      expect(result.entry.contribution.localId).toBe(expected);
      expect(result.shadowed).toBe(entries.length - 1);
      entries.splice(
        entries.findIndex((entry) => entry.contribution.localId === expected),
        1,
      );
    }
  });

  test("exact preference narrows aliases and missing preferences never fall through", () => {
    const preferred = { ...catalogFixture("chosen"), preferred: true };
    const snapshot = catalog([preferred, catalogFixture("development", "development")]);
    const request = { catalog: snapshot.identity, target: { kind: "alias", name: "shared" } };
    const implicit = resolveExtensionCatalog(snapshot, request);
    expect(implicit.status === "resolved" && implicit.entry.contribution.localId).toBe("chosen");
    const missing = resolveExtensionCatalog(snapshot, {
      ...request,
      target: { ...request.target, preference: bytesDigest("old-identity") },
    });
    expect(missing).toMatchObject({ status: "missing", reason: "exact-choice-missing" });
    const explicit = resolveExtensionCatalog(snapshot, {
      ...request,
      target: { ...request.target, preference: canonicalDigest(preferred.contribution) },
    });
    expect(explicit.status === "resolved" && explicit.reason).toBe("exact-preference");
  });

  test("does not resolve disabled or explicit-only entries through an alias", () => {
    for (const entry of [
      { ...catalogFixture(), enabled: false },
      { ...catalogFixture(), explicitOnly: true },
      { ...catalogFixture(), lifecycle: "historical" as const },
    ]) {
      const snapshot = catalog([entry]);
      expect(
        resolveExtensionCatalog(snapshot, {
          catalog: snapshot.identity,
          target: { kind: "alias", name: "shared" },
        }).status,
      ).toBe("missing");
    }
  });

  test("returns bounded ambiguity with omission counts and a generation-bound retry", () => {
    const snapshot = catalog(Array.from({ length: 8 }, (_, i) => catalogFixture(`owner-${i}`)));
    const request = { catalog: snapshot.identity, target: { kind: "alias", name: "shared" } };
    const result = resolveExtensionCatalog(snapshot, request);
    expect(result.status).toBe("ambiguous-contribution");
    if (result.status !== "ambiguous-contribution") throw new Error("ambiguity");
    expect(result.total).toBe(8);
    expect(result.cards).toHaveLength(4);
    expect(result.omitted).toBe(4);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2_048);
    for (const card of result.cards)
      expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(384);
    expect(resolveExtensionCatalog(snapshot, { ...request, retry: result.retry })).toEqual(result);
    expect(() =>
      resolveExtensionCatalog(snapshot, { ...request, retry: { ...result.retry, generation: 2 } }),
    ).toThrow("stale-catalog-handle");
    expect(() =>
      resolveExtensionCatalog(snapshot, {
        ...request,
        target: { kind: "alias", name: "another" },
        retry: result.retry,
      }),
    ).toThrow("stale-catalog-handle");
    expect(JSON.stringify(result)).not.toContain("shared");
  });

  test("tie-breaking requires equal validated native schema/effect/authority/result/settlement contracts", () => {
    const left = boundCatalogFixture("left");
    const right = boundCatalogFixture("right");
    const snapshot = catalog([left, right]);
    const result = resolveExtensionCatalog(snapshot, {
      catalog: snapshot.identity,
      target: { kind: "alias", name: "shared" },
    });
    expect(result.status === "resolved" && result.reason).toBe("equivalent-tie-break");
    for (const field of [
      "schemaDigest",
      "effectDigest",
      "authorityDigest",
      "resultDigest",
      "settlementDigest",
    ] as const) {
      const changed = catalog([
        left,
        boundCatalogFixture("right", { [field]: bytesDigest("different") }),
      ]);
      expect(
        resolveExtensionCatalog(changed, {
          catalog: changed.identity,
          target: { kind: "alias", name: "shared" },
        }).status,
      ).toBe("ambiguous-contribution");
    }
  });
  test("normalizes alias matching and retry identity together", () => {
    const snapshot = catalog(
      ["left", "right"].map((id) => ({ ...catalogFixture(id), aliases: ["e\u0301"] })),
    );
    const request = { catalog: snapshot.identity, target: { kind: "alias", name: "e\u0301" } };
    const result = resolveExtensionCatalog(snapshot, request);
    expect(result.status).toBe("ambiguous-contribution");
    if (result.status !== "ambiguous-contribution") throw new Error("ambiguity");
    expect(
      resolveExtensionCatalog(snapshot, {
        ...request,
        target: { kind: "alias", name: "é" },
        retry: result.retry,
      }),
    ).toEqual(result);
    expect(() =>
      resolveExtensionCatalog(snapshot, { ...request, target: { kind: "alias", name: "\ud800" } }),
    ).toThrow();
  });
});
