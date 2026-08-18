/**
 * Durable memory record definition: attribution, versioning, and lineage.
 */

import { describe, expect, test } from "bun:test";
import { memoryId, workspaceId } from "./identity.ts";
import { defineMemoryRecord, describeMemoryError, MEMORY_RECORD_VERSION } from "./memory-record.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const LATER = timestampFromEpochMilliseconds(1_700_000_360_000);

function baseInput(
  overrides: Record<string, unknown> = {},
): Parameters<typeof defineMemoryRecord>[0] {
  return {
    memoryId: "mem-1",
    scope: { kind: "workspace", workspaceId: "workspace-1" },
    kind: "project-fact",
    subject: "default branch",
    content: "The default branch is main.",
    provenance: [{ origin: "user-request", locator: "turn-1" }],
    confidence: 90,
    sensitivity: "user-content",
    createdAt: NOW,
    ...overrides,
  };
}

describe("defineMemoryRecord", () => {
  test("admits an attributed workspace fact at memory.v1", () => {
    const result = defineMemoryRecord(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.schemaVersion).toBe(MEMORY_RECORD_VERSION);
    expect(result.value.memoryId).toBe(memoryId.from("mem-1"));
    expect(result.value.generation).toBe(1);
    expect(result.value.scope).toEqual({
      kind: "workspace",
      workspaceId: workspaceId.from("workspace-1"),
    });
    expect(result.value.kind).toBe("project-fact");
    expect(result.value.provenance).toEqual([
      { origin: "user-request", locator: "turn-1", eventId: null },
    ]);
    expect(result.value.supersedes).toEqual([]);
    expect(result.value.reviewAfter).toBeNull();
    expect(result.value.expiresAt).toBeNull();
  });

  test("records a correction as a new identity with supersession lineage", () => {
    const original = defineMemoryRecord(baseInput());
    expect(original.ok).toBe(true);
    if (!original.ok) {
      return;
    }
    const correction = defineMemoryRecord(
      baseInput({
        memoryId: "mem-2",
        generation: 2,
        kind: "correction",
        content: "The default branch is trunk.",
        provenance: [{ origin: "correction", locator: "user-edit-1", eventId: "evt-9" }],
        supersedes: [original.value.memoryId],
      }),
    );
    expect(correction.ok).toBe(true);
    if (!correction.ok) {
      return;
    }
    expect(correction.value.memoryId).toBe(memoryId.from("mem-2"));
    expect(correction.value.generation).toBe(2);
    expect(correction.value.supersedes).toEqual([original.value.memoryId]);
    expect(original.value.content).toBe("The default branch is main.");
    expect(original.value.memoryId).not.toBe(correction.value.memoryId);
  });

  test("refuses inference persisted as durable truth", () => {
    const result = defineMemoryRecord(
      baseInput({
        provenance: [{ origin: "inference", locator: "model-guess" }],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "unsupported", field: "provenance.0.origin" },
    });
    if (result.ok) {
      return;
    }
    expect(describeMemoryError(result.error)).toBe("unsupported provenance.0.origin");
  });

  test("refuses conversation text auto-promoted to durable memory", () => {
    const result = defineMemoryRecord(
      baseInput({
        provenance: [{ origin: "conversation", locator: "transcript" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("unsupported");
  });

  test("refuses empty provenance", () => {
    const result = defineMemoryRecord(baseInput({ provenance: [] }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "empty", field: "provenance" },
    });
  });

  test("refuses a user scope that carries a workspace identity", () => {
    const result = defineMemoryRecord(
      baseInput({
        scope: { kind: "user", workspaceId: "workspace-1" },
        kind: "user-preference",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("malformed");
    expect(result.error.field).toMatch(/^scope/);
  });

  test("admits located repository scope", () => {
    const result = defineMemoryRecord(
      baseInput({
        scope: {
          kind: "repository",
          workspaceId: "workspace-1",
          locator: "github.com/tyldra-org/falryn",
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("refuses self-supersession", () => {
    const result = defineMemoryRecord(
      baseInput({
        generation: 2,
        supersedes: ["mem-1"],
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "malformed", field: "supersedes" },
    });
  });

  test("refuses duplicate supersession ids", () => {
    const result = defineMemoryRecord(
      baseInput({
        memoryId: "mem-3",
        generation: 2,
        supersedes: ["mem-1", "mem-1"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("malformed");
    expect(result.error.field).toBe("supersedes.1");
  });

  test("refuses generation 1 when superseding", () => {
    const result = defineMemoryRecord(
      baseInput({
        memoryId: "mem-2",
        generation: 1,
        supersedes: ["mem-1"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({ kind: "memory", code: "malformed", field: "generation" });
  });

  test("refuses generation 2 without supersession links", () => {
    const result = defineMemoryRecord(baseInput({ generation: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({ kind: "memory", code: "malformed", field: "generation" });
  });

  test("refuses unknown schema versions", () => {
    const result = defineMemoryRecord(baseInput({ schemaVersion: "memory.v0" }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "unsupported", field: "schemaVersion" },
    });
  });

  test("refuses cancelled definition", () => {
    const result = defineMemoryRecord(baseInput({ cancelled: true }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });

  test("refuses empty subject and oversized content", () => {
    const empty = defineMemoryRecord(baseInput({ subject: "   " }));
    expect(empty.ok).toBe(false);
    if (empty.ok) {
      return;
    }
    expect(empty.error).toEqual({
      kind: "memory",
      code: "empty",
      field: "subject",
    });
    const oversized = defineMemoryRecord(baseInput({ content: "x".repeat(8 * 1_024 + 1) }));
    expect(oversized.ok).toBe(false);
    if (oversized.ok) {
      return;
    }
    expect(oversized.error).toEqual({
      kind: "memory",
      code: "oversized",
      field: "content",
    });
  });

  test("refuses review or expiry earlier than createdAt", () => {
    const earlier = timestampFromEpochMilliseconds(1_699_999_000_000);
    const review = defineMemoryRecord(baseInput({ reviewAfter: earlier }));
    expect(review.ok).toBe(false);
    if (review.ok) {
      return;
    }
    expect(review.error).toEqual({
      kind: "memory",
      code: "stale",
      field: "reviewAfter",
    });
    const expiry = defineMemoryRecord(baseInput({ expiresAt: earlier }));
    expect(expiry.ok).toBe(false);
    if (expiry.ok) {
      return;
    }
    expect(expiry.error).toEqual({
      kind: "memory",
      code: "stale",
      field: "expiresAt",
    });
  });

  test("admits review and expiry after creation", () => {
    const result = defineMemoryRecord(baseInput({ reviewAfter: LATER, expiresAt: LATER }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.reviewAfter).toBe(LATER);
    expect(result.value.expiresAt).toBe(LATER);
  });

  test("describeMemoryError names every code", () => {
    expect(describeMemoryError({ kind: "memory", code: "malformed", field: "kind" })).toBe(
      "malformed kind",
    );
    expect(describeMemoryError({ kind: "memory", code: "conflict", field: "memoryId" })).toBe(
      "conflict memoryId",
    );
    expect(describeMemoryError({ kind: "memory", code: "unavailable", field: null })).toBe(
      "unavailable memory",
    );
  });
});
