/**
 * Memory admission: source trust, sensitivity, and workspace isolation.
 */

import { describe, expect, test } from "bun:test";
import { workspaceId } from "./identity.ts";
import { admitMemoryCandidate, MEMORY_ADMISSION_VERSION } from "./memory-admission.ts";
import { defineMemoryRecord } from "./memory-record.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

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
    sensitivity: "user-content",
    createdAt: NOW,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    sourceKind: "user",
    sourceTrust: "user-confirmed",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

describe("admitMemoryCandidate", () => {
  test("admits a user-confirmed workspace fact at memory-admit.v1", () => {
    const result = admitMemoryCandidate(fact(), context());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.strategyVersion).toBe(MEMORY_ADMISSION_VERSION);
    expect(result.value.sourceKind).toBe("user");
    expect(result.value.record.scope).toEqual({
      kind: "workspace",
      workspaceId: workspaceId.from("workspace-1"),
    });
  });

  test("refuses repository and web sources as direct writers", () => {
    const repo = admitMemoryCandidate(fact(), context({ sourceKind: "repository" }));
    expect(repo.ok).toBe(false);
    if (!repo.ok) {
      expect(repo.error).toEqual({ kind: "memory", code: "denied", field: "sourceKind" });
    }
    const web = admitMemoryCandidate(fact(), context({ sourceKind: "web" }));
    expect(web.ok).toBe(false);
    if (!web.ok) {
      expect(web.error.code).toBe("denied");
    }
  });

  test("refuses inferred or untrusted sources", () => {
    const inferred = admitMemoryCandidate(fact(), context({ sourceTrust: "inferred" }));
    expect(inferred).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "sourceTrust" },
    });
    const untrusted = admitMemoryCandidate(fact(), context({ sourceTrust: "untrusted" }));
    expect(untrusted.ok).toBe(false);
    if (untrusted.ok) {
      return;
    }
    expect(untrusted.error).toEqual({ kind: "memory", code: "denied", field: "sourceTrust" });
  });

  test("refuses restricted sensitivity and user-wide sensitive facts", () => {
    const restricted = admitMemoryCandidate(fact({ sensitivity: "restricted" }), context());
    expect(restricted).toEqual({
      ok: false,
      error: { kind: "memory", code: "secret", field: "sensitivity" },
    });
    const broad = admitMemoryCandidate(
      fact({
        scope: { kind: "user" },
        kind: "user-preference",
        sensitivity: "sensitive",
      }),
      context(),
    );
    expect(broad).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "sensitivity" },
    });
  });

  test("refuses project facts that broaden to user scope", () => {
    const result = admitMemoryCandidate(
      fact({ scope: { kind: "user" }, kind: "project-fact", sensitivity: "public" }),
      context(),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "kind" },
    });
  });

  test("refuses a record whose workspace does not match the admitting context", () => {
    const result = admitMemoryCandidate(fact(), context({ workspaceId: "workspace-2" }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "scope.workspaceId" },
    });
  });

  test("refuses consolidation that would broaden a sensitive prior", () => {
    const prior = defineMemoryRecord(
      fact({
        memoryId: "mem-prior",
        sensitivity: "sensitive",
      }),
    );
    expect(prior.ok).toBe(true);
    if (!prior.ok) {
      return;
    }
    const result = admitMemoryCandidate(
      fact({
        memoryId: "mem-2",
        generation: 2,
        scope: { kind: "user" },
        kind: "user-preference",
        sensitivity: "public",
        supersedes: ["mem-prior"],
      }),
      context({ priors: [prior.value] }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "scope" },
    });
  });

  test("refuses a tool source without user confirmation", () => {
    const result = admitMemoryCandidate(
      fact(),
      context({ sourceKind: "tool", sourceTrust: "adapter-declared" }),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "sourceTrust" },
    });
  });

  test("cancels before applying admission", () => {
    const result = admitMemoryCandidate(fact(), context({ cancelled: true }));
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });
});
