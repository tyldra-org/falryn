/**
 * Memory record port: secret refusal, identity conflict, and lineage stability.
 */

import { describe, expect, test } from "bun:test";

import { timestampFromEpochMilliseconds } from "../domain/index.ts";
import { createMemoryRecords } from "./memory-record.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);

function fact(overrides: Record<string, unknown> = {}) {
  return {
    memoryId: "mem-1",
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    kind: "project-fact",
    subject: "default branch",
    content: "The default branch is main.",
    provenance: [{ origin: "user-request", locator: "turn-1" }],
    confidence: 90,
    createdAt: NOW,
    ...overrides,
  };
}

describe("createMemoryRecords", () => {
  test("stores a record and refuses secret-shaped content", () => {
    const store = createMemoryRecords();
    const defined = store.define(fact());
    expect(defined.ok).toBe(true);
    const leaked = store.define(
      fact({
        memoryId: "mem-secret",
        content: "deploy with token sk-live-SECRET-MUST-NOT-ESCAPE",
      }),
    );
    expect(leaked).toEqual({
      ok: false,
      error: { kind: "memory", code: "secret", field: "content" },
    });
    expect(store.get("mem-secret").ok).toBe(false);
  });

  test("does not overwrite an existing identity when a correction arrives", () => {
    const store = createMemoryRecords();
    const first = store.define(fact());
    expect(first.ok).toBe(true);
    const conflict = store.define(fact({ content: "overwrite attempt" }));
    expect(conflict).toEqual({
      ok: false,
      error: { kind: "memory", code: "conflict", field: "memoryId" },
    });
    const correction = store.define(
      fact({
        memoryId: "mem-2",
        generation: 2,
        kind: "correction",
        content: "The default branch is trunk.",
        provenance: [{ origin: "correction", locator: "user-edit" }],
        supersedes: ["mem-1"],
      }),
    );
    expect(correction.ok).toBe(true);
    const original = store.get("mem-1");
    expect(original.ok).toBe(true);
    if (!original.ok) {
      return;
    }
    expect(original.value.content).toBe("The default branch is main.");
  });

  test("cancels before defining and reports missing records as unavailable", () => {
    const store = createMemoryRecords();
    const signal = AbortSignal.abort();
    expect(store.define(fact(), signal)).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
    expect(store.get("mem-missing")).toEqual({
      ok: false,
      error: { kind: "memory", code: "unavailable", field: "memoryId" },
    });
  });
});
