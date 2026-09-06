/**
 * Application boundary for context-governed memory admission (#110).
 *
 * Secret-shaped candidates fail closed before policy. Admitted records enter
 * the in-memory store without overwriting an existing id. Recall and product
 * tools remain later.
 */

import { err, type Result } from "../../domain/foundation/index.ts";
import {
  admitMemoryCandidate,
  type MemoryAdmissionContextInput,
  type MemoryAdmissionResult,
  type MemoryError,
  type MemoryRecord,
  type MemoryRecordInput,
} from "../../domain/memory/index.ts";
import { containsRedactableSecret } from "../diagnostics/redaction.ts";
import { createMemoryRecords, type MemoryRecords } from "./memory-record.ts";

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

export type MemoryAdmissionPort = {
  admit(
    input: MemoryRecordInput,
    context: MemoryAdmissionContextInput,
    signal?: AbortSignal,
  ): Result<MemoryAdmissionResult, MemoryError>;
  get(id: unknown): Result<MemoryRecord, MemoryError>;
};

export function createMemoryAdmission(
  records: MemoryRecords = createMemoryRecords(),
): MemoryAdmissionPort {
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
      const stored = records.define(input, signal);
      if (!stored.ok) {
        return stored;
      }
      return admitted;
    },
    get(id) {
      return records.get(id);
    },
  };
}
