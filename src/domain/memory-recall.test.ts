/**
 * Memory recall: workspace isolation, freshness, ranking, and contradictions.
 */

import { describe, expect, test } from "bun:test";
import { memoryId } from "./identity.ts";
import { MEMORY_RECALL_VERSION, recallMemory } from "./memory-recall.ts";
import { defineMemoryRecord } from "./memory-record.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const LATER = timestampFromEpochMilliseconds(1_700_086_400_000);

function record(overrides: Record<string, unknown> = {}) {
  const defined = defineMemoryRecord({
    memoryId: "mem-1",
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    kind: "project-fact",
    subject: "default branch",
    content: "The default branch is main.",
    provenance: [{ origin: "user-request", locator: "turn-1" }],
    confidence: 80,
    sensitivity: "user-content",
    createdAt: NOW,
    ...overrides,
  });
  expect(defined.ok).toBe(true);
  if (!defined.ok) {
    throw new Error("fixture");
  }
  return defined.value;
}

describe("recallMemory", () => {
  test("ranks a matching workspace fact and reports the strategy version", () => {
    const result = recallMemory({
      records: [record()],
      workspaceId: "workspace-1",
      query: "default branch",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.strategyVersion).toBe(MEMORY_RECALL_VERSION);
    expect(result.value.selected).toHaveLength(1);
    expect(result.value.selected[0]?.reasons).toContain("query-relevance");
    expect(result.value.contradictions).toEqual([]);
  });

  test("does not leak a project fact into another workspace", () => {
    const result = recallMemory({
      records: [record()],
      workspaceId: "workspace-2",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.selected).toEqual([]);
    expect(result.value.omitted).toEqual([
      { memoryId: memoryId.from("mem-1"), reason: "wrong-workspace" },
    ]);
  });

  test("excludes expired and stale records", () => {
    const expired = record({ memoryId: "mem-exp", expiresAt: NOW });
    const stale = record({ memoryId: "mem-stale", reviewAfter: NOW });
    const live = record({ memoryId: "mem-live" });
    const result = recallMemory({
      records: [expired, stale, live],
      workspaceId: "workspace-1",
      now: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.selected.map((hit) => hit.record.memoryId)).toEqual([
      memoryId.from("mem-live"),
    ]);
    expect(result.value.omitted.map((item) => item.reason).sort()).toEqual(["expired", "stale"]);
  });

  test("omits memories that exceed destination sensitivity", () => {
    const result = recallMemory({
      records: [record({ sensitivity: "sensitive" })],
      workspaceId: "workspace-1",
      destination: "public",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.omitted[0]?.reason).toBe("sensitivity");
  });

  test("keeps contradictory facts visible and does not prefer newer", () => {
    const first = record({
      memoryId: "mem-a",
      content: "The default branch is main.",
      confidence: 40,
    });
    const second = record({
      memoryId: "mem-b",
      content: "The default branch is trunk.",
      confidence: 90,
      createdAt: LATER,
    });
    const result = recallMemory({
      records: [first, second],
      workspaceId: "workspace-1",
      query: "default",
      now: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.selected).toHaveLength(2);
    expect(result.value.contradictions).toHaveLength(1);
    expect(result.value.contradictions[0]?.memoryIds).toEqual([
      memoryId.from("mem-b"),
      memoryId.from("mem-a"),
    ]);
    expect(result.value.selected.every((hit) => hit.reasons.includes("contradiction"))).toBe(true);
  });

  test("omits a superseded identity rather than treating it as a contradiction", () => {
    const original = record({ memoryId: "mem-old" });
    const correction = record({
      memoryId: "mem-new",
      generation: 2,
      kind: "correction",
      content: "The default branch is trunk.",
      provenance: [{ origin: "correction", locator: "user-edit" }],
      supersedes: ["mem-old"],
    });
    const result = recallMemory({
      records: [original, correction],
      workspaceId: "workspace-1",
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.selected.map((hit) => hit.record.memoryId)).toEqual([
      memoryId.from("mem-new"),
    ]);
    expect(result.value.omitted).toEqual([
      { memoryId: memoryId.from("mem-old"), reason: "superseded" },
    ]);
    expect(result.value.contradictions).toEqual([]);
  });

  test("applies a rank limit and cancels before scoring", () => {
    const records = [
      record({ memoryId: "mem-1", subject: "alpha", content: "one" }),
      record({ memoryId: "mem-2", subject: "beta", content: "two" }),
    ];
    const limited = recallMemory({
      records,
      workspaceId: "workspace-1",
      maxResults: 1,
      now: NOW,
    });
    expect(limited.ok).toBe(true);
    if (limited.ok) {
      expect(limited.value.selected).toHaveLength(1);
      expect(limited.value.omitted.some((item) => item.reason === "rank-limit")).toBe(true);
    }
    const cancelled = recallMemory({
      records,
      workspaceId: "workspace-1",
      cancelled: true,
    });
    expect(cancelled).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });
});
