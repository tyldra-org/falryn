/**
 * Memory admission port: secrets, denied sources, and workspace isolation.
 */

import { describe, expect, test } from "bun:test";

import { timestampFromEpochMilliseconds } from "../domain/index.ts";
import { createMemoryAdmission } from "./memory-admission.ts";

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

function context(overrides: Record<string, unknown> = {}) {
  return {
    sourceKind: "user",
    sourceTrust: "user-confirmed",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

describe("createMemoryAdmission", () => {
  test("stores an admitted record and refuses secret-shaped content", () => {
    const port = createMemoryAdmission();
    const admitted = port.admit(fact(), context());
    expect(admitted.ok).toBe(true);
    const leaked = port.admit(
      fact({
        memoryId: "mem-secret",
        content: "token sk-live-SECRET-MUST-NOT-ESCAPE",
      }),
      context(),
    );
    expect(leaked).toEqual({
      ok: false,
      error: { kind: "memory", code: "secret", field: "content" },
    });
    expect(port.get("mem-secret").ok).toBe(false);
    expect(port.get("mem-1").ok).toBe(true);
  });

  test("does not store a denied cross-workspace candidate", () => {
    const port = createMemoryAdmission();
    const denied = port.admit(fact(), context({ workspaceId: "workspace-other" }));
    expect(denied).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "scope.workspaceId" },
    });
    expect(port.get("mem-1")).toEqual({
      ok: false,
      error: { kind: "memory", code: "unavailable", field: "memoryId" },
    });
  });

  test("cancels before admission", () => {
    const port = createMemoryAdmission();
    const result = port.admit(fact(), context(), AbortSignal.abort());
    expect(result).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });
});
