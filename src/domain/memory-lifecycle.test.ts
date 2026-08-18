/**
 * Memory lifecycle: correction lineage, deletion receipts, and expiry overlays.
 */

import { describe, expect, test } from "bun:test";

import { memoryId } from "./identity.ts";
import {
  MEMORY_LIFECYCLE_VERSION,
  planMemoryCorrection,
  planMemoryDeletion,
  planMemoryExpiry,
  projectExpiredRecord,
} from "./memory-lifecycle.ts";
import { defineMemoryRecord } from "./memory-record.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const LATER = timestampFromEpochMilliseconds(1_700_000_360_000);

function fact(overrides: Record<string, unknown> = {}) {
  const defined = defineMemoryRecord({
    memoryId: "mem-1",
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    kind: "project-fact",
    subject: "default branch",
    content: "The default branch is main.",
    provenance: [{ origin: "user-request", locator: "turn-1" }],
    confidence: 80,
    createdAt: NOW,
    ...overrides,
  });
  expect(defined.ok).toBe(true);
  if (!defined.ok) {
    throw new Error("fixture");
  }
  return defined.value;
}

describe("planMemoryCorrection", () => {
  test("creates a new identity and leaves the original record unchanged", () => {
    const current = fact();
    const result = planMemoryCorrection({
      current,
      replacement: {
        memoryId: "mem-2",
        generation: 2,
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        kind: "correction",
        subject: "default branch",
        content: "The default branch is trunk.",
        provenance: [{ origin: "correction", locator: "user-edit" }],
        confidence: 100,
        createdAt: LATER,
        supersedes: ["mem-1"],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.memoryId).toBe(memoryId.from("mem-2"));
    expect(result.value.supersedes).toEqual([memoryId.from("mem-1")]);
    expect(current.content).toBe("The default branch is main.");
    expect(current.memoryId).toBe(memoryId.from("mem-1"));
  });

  test("refuses an in-place overwrite", () => {
    const current = fact();
    const result = planMemoryCorrection({
      current,
      replacement: {
        memoryId: "mem-1",
        generation: 2,
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        kind: "correction",
        subject: "default branch",
        content: "overwrite",
        provenance: [{ origin: "correction", locator: "user-edit" }],
        confidence: 100,
        createdAt: LATER,
        supersedes: ["mem-1"],
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "conflict", field: "memoryId" },
    });
  });

  test("requires a later generation and a supersession link to the current identity", () => {
    const current = fact();
    const missingLink = planMemoryCorrection({
      current,
      replacement: {
        memoryId: "mem-2",
        generation: 2,
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        kind: "correction",
        subject: "default branch",
        content: "The default branch is trunk.",
        provenance: [{ origin: "correction", locator: "user-edit" }],
        confidence: 100,
        createdAt: LATER,
        supersedes: ["mem-other"],
      },
    });
    expect(missingLink).toEqual({
      ok: false,
      error: { kind: "memory", code: "malformed", field: "supersedes" },
    });
    const laterCurrent = fact({
      memoryId: "mem-3",
      generation: 3,
      supersedes: ["mem-1"],
    });
    const staleGeneration = planMemoryCorrection({
      current: laterCurrent,
      replacement: {
        memoryId: "mem-4",
        generation: 2,
        scope: { kind: "workspace", workspaceId: "workspace-1" },
        kind: "correction",
        subject: "default branch",
        content: "The default branch is trunk.",
        provenance: [{ origin: "correction", locator: "user-edit" }],
        confidence: 100,
        createdAt: LATER,
        supersedes: ["mem-3"],
      },
    });
    expect(staleGeneration).toEqual({
      ok: false,
      error: { kind: "memory", code: "malformed", field: "generation" },
    });
  });
});

describe("planMemoryDeletion", () => {
  test("records retained export handles on a deletion receipt", () => {
    const result = planMemoryDeletion({
      memoryId: "mem-1",
      deletedAt: NOW,
      retained: [{ kind: "export", locator: "exports/mem-1.json" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.schemaVersion).toBe(MEMORY_LIFECYCLE_VERSION);
    expect(result.value.memoryId).toBe(memoryId.from("mem-1"));
    expect(result.value.retained).toEqual([{ kind: "export", locator: "exports/mem-1.json" }]);
  });

  test("cancels before deleting", () => {
    expect(planMemoryDeletion({ memoryId: "mem-1", deletedAt: NOW, cancelled: true })).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });
});

describe("planMemoryExpiry", () => {
  test("accepts an overlay at or after createdAt without rewriting the record", () => {
    const current = fact();
    const result = planMemoryExpiry({ current, expiresAt: LATER });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(current.expiresAt).toBeNull();
    expect(projectExpiredRecord(current, result.value).expiresAt).toBe(LATER);
  });

  test("refuses expiry earlier than createdAt", () => {
    const current = fact();
    const earlier = timestampFromEpochMilliseconds(1_699_999_000_000);
    const result = planMemoryExpiry({ current, expiresAt: earlier });
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "stale", field: "expiresAt" },
    });
  });
});
