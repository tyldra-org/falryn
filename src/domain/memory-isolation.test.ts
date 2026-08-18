/**
 * Memory isolation: workspace export, replay, and telemetry without text.
 */

import { describe, expect, test } from "bun:test";
import { memoryId, workspaceId } from "./identity.ts";
import {
  MEMORY_ISOLATION_VERSION,
  projectMemoryExport,
  projectMemoryTelemetry,
} from "./memory-isolation.ts";
import { defineMemoryRecord } from "./memory-record.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);

function fact(id: string, workspace: string, content: string) {
  const defined = defineMemoryRecord({
    memoryId: id,
    scope: { kind: "workspace", workspaceId: workspace },
    kind: "project-fact",
    subject: "default branch",
    content,
    provenance: [{ origin: "user-request", locator: "turn-1" }],
    confidence: 80,
    createdAt: NOW,
  });
  expect(defined.ok).toBe(true);
  if (!defined.ok) {
    throw new Error("fixture");
  }
  return defined.value;
}

describe("projectMemoryExport", () => {
  test("keeps only the requested workspace and user-wide records", () => {
    const result = projectMemoryExport({
      workspaceId: "workspace-a",
      records: [
        fact("mem-a", "workspace-a", "Alpha uses main."),
        fact("mem-b", "workspace-b", "Beta uses trunk."),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.schemaVersion).toBe(MEMORY_ISOLATION_VERSION);
    expect(result.value.workspaceId).toBe(workspaceId.from("workspace-a"));
    expect(result.value.records.map((record) => record.memoryId)).toEqual([memoryId.from("mem-a")]);
  });

  test("cancels before exporting", () => {
    expect(
      projectMemoryExport({ workspaceId: "workspace-a", records: [], cancelled: true }),
    ).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });
});

describe("projectMemoryTelemetry", () => {
  test("reports counts and kinds without memory text", () => {
    const result = projectMemoryTelemetry({
      workspaceId: "workspace-a",
      records: [fact("mem-a", "workspace-a", "Alpha uses main.")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.recordCount).toBe(1);
    expect(result.value.kinds).toEqual(["project-fact"]);
    expect(JSON.stringify(result.value)).not.toContain("Alpha uses main.");
    expect(JSON.stringify(result.value)).not.toContain("default branch");
  });
});
