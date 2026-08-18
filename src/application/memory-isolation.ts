/**
 * Application boundary for memory privacy, export, replay, and isolation (#114).
 *
 * Export and replay stay inside one workspace. Telemetry never receives memory
 * text. Untrusted sources remain denied even when repeated. Product tools later.
 */

import {
  admitMemoryCandidate,
  err,
  type MemoryAdmissionContextInput,
  type MemoryError,
  type MemoryExport,
  type MemoryRecordInput,
  type MemoryTelemetryProjection,
  projectMemoryExport,
  projectMemoryTelemetry,
  type Result,
} from "../domain/index.ts";
import { createMemoryLifecycle } from "./memory-lifecycle.ts";
import { createMemoryRecords, type MemoryRecords } from "./memory-record.ts";
import { containsRedactableSecret } from "./redaction.ts";

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

export type MemoryIsolation = {
  admit(
    input: MemoryRecordInput,
    context: MemoryAdmissionContextInput,
    signal?: AbortSignal,
  ): Result<unknown, MemoryError>;
  exportWorkspace(workspaceId: unknown, signal?: AbortSignal): Result<MemoryExport, MemoryError>;
  telemetry(
    workspaceId: unknown,
    signal?: AbortSignal,
  ): Result<MemoryTelemetryProjection, MemoryError>;
  replay(snapshot: MemoryExport, signal?: AbortSignal): Result<MemoryExport, MemoryError>;
};

export function createMemoryIsolation(
  records: MemoryRecords = createMemoryRecords(),
): MemoryIsolation {
  const lifecycle = createMemoryLifecycle(records);

  return {
    admit(input, context, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      if (typeof input.subject === "string" && containsRedactableSecret(input.subject)) {
        return err(memoryError("secret", "subject"));
      }
      if (typeof input.content === "string" && containsRedactableSecret(input.content)) {
        return err(memoryError("secret", "content"));
      }
      const admitted = admitMemoryCandidate(input, context);
      if (!admitted.ok) {
        return admitted;
      }
      return records.define(input);
    },
    exportWorkspace(workspaceId, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      return projectMemoryExport({ workspaceId, records: lifecycle.listActive() });
    },
    telemetry(workspaceId, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      return projectMemoryTelemetry({ workspaceId, records: lifecycle.listActive() });
    },
    replay(snapshot, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      const restored = createMemoryRecords();
      for (const record of snapshot.records) {
        const stored = restored.define({
          memoryId: record.memoryId,
          generation: record.generation,
          scope: record.scope,
          kind: record.kind,
          subject: record.subject,
          content: record.content,
          provenance: record.provenance.map((entry) => ({
            origin: entry.origin,
            locator: entry.locator,
          })),
          confidence: record.confidence,
          sensitivity: record.sensitivity,
          createdAt: record.createdAt,
          supersedes: record.supersedes,
        });
        if (!stored.ok) {
          return stored;
        }
      }
      return projectMemoryExport({
        workspaceId: snapshot.workspaceId,
        records: restored.list(),
      });
    },
  };
}
