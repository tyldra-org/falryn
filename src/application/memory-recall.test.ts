/**
 * Memory recall port: isolation, cancellation, and store-backed ranking.
 */

import { describe, expect, test } from "bun:test";

import { memoryId, timestampFromEpochMilliseconds } from "../domain/index.ts";
import { createMemoryRecall } from "./memory-recall.ts";
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
    confidence: 80,
    createdAt: NOW,
    ...overrides,
  };
}

describe("createMemoryRecall", () => {
  test("recalls an admitted workspace record and hides a foreign workspace", () => {
    const store = createMemoryRecords();
    expect(store.define(fact()).ok).toBe(true);
    expect(
      store.define(
        fact({
          memoryId: "mem-other",
          scope: { kind: "workspace", workspaceId: "workspace-2" },
          subject: "other",
        }),
      ).ok,
    ).toBe(true);
    const port = createMemoryRecall(store);
    const home = port.recall({ workspaceId: "workspace-1", now: NOW });
    expect(home.ok).toBe(true);
    if (!home.ok) {
      return;
    }
    expect(home.value.selected.map((hit) => hit.record.memoryId)).toEqual([memoryId.from("mem-1")]);
    const away = port.recall({ workspaceId: "workspace-2", now: NOW });
    expect(away.ok).toBe(true);
    if (!away.ok) {
      return;
    }
    expect(away.value.selected.map((hit) => hit.record.memoryId)).toEqual([
      memoryId.from("mem-other"),
    ]);
  });

  test("cancels before reading the store", () => {
    const store = createMemoryRecords();
    expect(store.define(fact()).ok).toBe(true);
    const port = createMemoryRecall(store);
    expect(port.recall({ workspaceId: "workspace-1" }, AbortSignal.abort())).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });
});
