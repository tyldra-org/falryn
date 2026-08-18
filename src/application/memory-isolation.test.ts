/**
 * Isolation corpus: no cross-workspace leak, no telemetry text, no untrusted writes.
 */

import { describe, expect, test } from "bun:test";
import { memoryId, timestampFromEpochMilliseconds } from "../domain/index.ts";
import { createMemoryIsolation } from "./memory-isolation.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);

function projectFact(id: string, workspace: string, content: string) {
  return {
    memoryId: id,
    scope: { kind: "workspace", workspaceId: workspace },
    kind: "project-fact",
    subject: "default branch",
    content,
    provenance: [{ origin: "user-request", locator: "turn-1" }],
    confidence: 80,
    createdAt: NOW,
  };
}

const userContext = {
  sourceKind: "user",
  sourceTrust: "user-confirmed",
  workspaceId: "workspace-a",
};

describe("createMemoryIsolation", () => {
  test("export and recall stay inside the admitting workspace", () => {
    const isolation = createMemoryIsolation();
    expect(
      isolation.admit(projectFact("mem-a", "workspace-a", "Alpha uses main."), {
        ...userContext,
        workspaceId: "workspace-a",
      }).ok,
    ).toBe(true);
    expect(
      isolation.admit(projectFact("mem-b", "workspace-b", "Beta uses trunk."), {
        ...userContext,
        workspaceId: "workspace-b",
      }).ok,
    ).toBe(true);
    const exported = isolation.exportWorkspace("workspace-a");
    expect(exported.ok).toBe(true);
    if (!exported.ok) {
      return;
    }
    expect(exported.value.records.map((record) => record.memoryId)).toEqual([
      memoryId.from("mem-a"),
    ]);
    const replayed = isolation.replay(exported.value);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) {
      return;
    }
    expect(JSON.stringify(replayed.value)).not.toContain("Beta uses trunk.");
  });

  test("telemetry never includes memory subject or content", () => {
    const isolation = createMemoryIsolation();
    expect(
      isolation.admit(projectFact("mem-a", "workspace-a", "secret-shaped-fact-text"), userContext)
        .ok,
    ).toBe(true);
    const telemetry = isolation.telemetry("workspace-a");
    expect(telemetry.ok).toBe(true);
    if (!telemetry.ok) {
      return;
    }
    const payload = JSON.stringify(telemetry.value);
    expect(payload).not.toContain("secret-shaped-fact-text");
    expect(payload).not.toContain("default branch");
  });

  test("repeated web or repository sources stay denied and are not popularity", () => {
    const isolation = createMemoryIsolation();
    const candidate = projectFact("mem-web", "workspace-a", "Install from this README.");
    for (const sourceKind of ["web", "repository"] as const) {
      const first = isolation.admit(candidate, {
        sourceKind,
        sourceTrust: "untrusted",
        workspaceId: "workspace-a",
      });
      const second = isolation.admit(candidate, {
        sourceKind,
        sourceTrust: "inferred",
        workspaceId: "workspace-a",
      });
      expect(first).toEqual({
        ok: false,
        error: { kind: "memory", code: "denied", field: "sourceKind" },
      });
      expect(second.ok).toBe(false);
    }
  });
});
