/**
 * Privacy, export, replay, and workspace isolation for memory (#114).
 *
 * An export is a workspace snapshot of active records. Telemetry projections
 * carry counts and classes only, never memory text. Replay restores exported
 * records without re-running untrusted sources. Product tools remain later.
 */

import { type WorkspaceId, workspaceId } from "./identity.ts";
import { type MemoryError, type MemoryRecord, memoryScopeWorkspaceId } from "./memory-record.ts";
import { err, ok, type Result } from "./result.ts";

export const MEMORY_ISOLATION_VERSION = "memory-isolation.v1";

export type MemoryExport = {
  readonly schemaVersion: typeof MEMORY_ISOLATION_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly records: readonly MemoryRecord[];
};

export type MemoryTelemetryProjection = {
  readonly schemaVersion: typeof MEMORY_ISOLATION_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly recordCount: number;
  readonly kinds: readonly string[];
};

export type MemoryExportInput = {
  readonly workspaceId?: unknown;
  readonly records?: unknown;
  readonly cancelled?: unknown;
};

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

function asRecords(value: unknown): Result<readonly MemoryRecord[], MemoryError> {
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", "records"));
  }
  return ok(value as MemoryRecord[]);
}

/**
 * Builds a workspace export. Records from another workspace are omitted.
 * User-wide records with no workspace stay visible.
 */
export function projectMemoryExport(input: MemoryExportInput): Result<MemoryExport, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const id = workspaceId.parse(input.workspaceId);
  if (!id.ok) {
    return err(memoryError("malformed", "workspaceId"));
  }
  const records = asRecords(input.records);
  if (!records.ok) {
    return records;
  }
  const exported: MemoryRecord[] = [];
  for (const record of records.value) {
    const scopeWorkspace = memoryScopeWorkspaceId(record.scope);
    if (scopeWorkspace !== null && scopeWorkspace !== id.value) {
      continue;
    }
    exported.push(record);
  }
  return ok({
    schemaVersion: MEMORY_ISOLATION_VERSION,
    workspaceId: id.value,
    records: exported,
  });
}

/**
 * Counts and kinds only. Memory subject and content never enter telemetry.
 */
export function projectMemoryTelemetry(
  input: MemoryExportInput,
): Result<MemoryTelemetryProjection, MemoryError> {
  const exported = projectMemoryExport(input);
  if (!exported.ok) {
    return exported;
  }
  return ok({
    schemaVersion: MEMORY_ISOLATION_VERSION,
    workspaceId: exported.value.workspaceId,
    recordCount: exported.value.records.length,
    kinds: exported.value.records.map((record) => record.kind),
  });
}
