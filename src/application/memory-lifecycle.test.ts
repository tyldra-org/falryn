/**
 * Memory lifecycle port: correction, deletion receipts, and active listing.
 */

import { describe, expect, test } from "bun:test";

import { memoryId, recallMemory, timestampFromEpochMilliseconds } from "../domain/index.ts";
import { createMemoryLifecycle } from "./memory-lifecycle.ts";
import { createMemoryRecords } from "./memory-record.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const LATER = timestampFromEpochMilliseconds(1_700_000_360_000);

function fact(overrides: Record<string, unknown> = {}) {
  return {
    memoryId: "mem-1",
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    kind: "project-fact",
    subject: "default branch",
    content: "The default branch is main.",
    provenance: [{ origin: "user-request", locator: "turn-1" }],
    confidence: 80,
    createdAt: NOW,
    ...overrides,
  };
}

describe("createMemoryLifecycle", () => {
  test("corrects by supersession and keeps the original canonical record", () => {
    const store = createMemoryRecords();
    const life = createMemoryLifecycle(store);
    expect(store.define(fact()).ok).toBe(true);
    const corrected = life.correct("mem-1", {
      ...fact({
        memoryId: "mem-2",
        generation: 2,
        kind: "correction",
        content: "The default branch is trunk.",
        provenance: [{ origin: "correction", locator: "user-edit" }],
        createdAt: LATER,
        supersedes: ["mem-1"],
      }),
    });
    expect(corrected.ok).toBe(true);
    const original = store.get("mem-1");
    expect(original.ok).toBe(true);
    if (original.ok) {
      expect(original.value.content).toBe("The default branch is main.");
    }
    const recalled = recallMemory({
      records: life.listActive(),
      workspaceId: "workspace-1",
      now: LATER,
    });
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(recalled.value.selected.map((hit) => hit.record.memoryId)).toEqual([
        memoryId.from("mem-2"),
      ]);
    }
  });

  test("deletes without resurfacing and reports retained exports", () => {
    const store = createMemoryRecords();
    const life = createMemoryLifecycle(store);
    expect(store.define(fact()).ok).toBe(true);
    const deleted = life.delete("mem-1", NOW, [{ kind: "export", locator: "exports/mem-1.json" }]);
    expect(deleted.ok).toBe(true);
    const receipt = life.deletion("mem-1");
    expect(receipt.ok).toBe(true);
    if (receipt.ok) {
      expect(receipt.value.retained).toEqual([{ kind: "export", locator: "exports/mem-1.json" }]);
    }
    expect(store.get("mem-1").ok).toBe(true);
    const recalled = recallMemory({
      records: life.listActive(),
      workspaceId: "workspace-1",
      now: NOW,
    });
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(recalled.value.selected).toEqual([]);
    }
  });

  test("expiry overlay hides a record from recall without rewriting it", () => {
    const store = createMemoryRecords();
    const life = createMemoryLifecycle(store);
    expect(store.define(fact()).ok).toBe(true);
    expect(life.expire("mem-1", LATER).ok).toBe(true);
    const canonical = store.get("mem-1");
    expect(canonical.ok).toBe(true);
    if (canonical.ok) {
      expect(canonical.value.expiresAt).toBeNull();
    }
    const recalled = recallMemory({
      records: life.listActive(),
      workspaceId: "workspace-1",
      now: timestampFromEpochMilliseconds(1_700_000_720_000),
    });
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(recalled.value.omitted[0]?.reason).toBe("expired");
    }
  });

  test("refuses secret-shaped correction content, cancelled work, and edits to deleted records", () => {
    const store = createMemoryRecords();
    const life = createMemoryLifecycle(store);
    expect(store.define(fact()).ok).toBe(true);
    expect(
      life.correct("mem-1", {
        ...fact({
          memoryId: "mem-secret",
          generation: 2,
          kind: "correction",
          content: "token sk-live-SECRET-MUST-NOT-ESCAPE",
          provenance: [{ origin: "correction", locator: "user-edit" }],
          createdAt: LATER,
          supersedes: ["mem-1"],
        }),
      }),
    ).toEqual({
      ok: false,
      error: { kind: "memory", code: "secret", field: "content" },
    });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(life.delete("mem-1", NOW, [], cancelled.signal)).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
    expect(life.delete("mem-1", NOW).ok).toBe(true);
    expect(life.delete("mem-1", NOW)).toEqual({
      ok: false,
      error: { kind: "memory", code: "conflict", field: "memoryId" },
    });
    expect(
      life.correct("mem-1", {
        ...fact({
          memoryId: "mem-2",
          generation: 2,
          kind: "correction",
          content: "The default branch is trunk.",
          provenance: [{ origin: "correction", locator: "user-edit" }],
          createdAt: LATER,
          supersedes: ["mem-1"],
        }),
      }),
    ).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "memoryId" },
    });
  });
});
