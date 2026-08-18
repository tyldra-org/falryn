/**
 * Application boundary for durable memory records (#109).
 *
 * Secret-shaped subject or content fails closed instead of becoming a stored
 * fact. Duplicate identities do not overwrite an existing record. Product
 * tools, SQLite persistence, admission policy, and recall remain later.
 */

import {
  defineMemoryRecord,
  err,
  type MemoryError,
  type MemoryRecord,
  type MemoryRecordInput,
  memoryId,
  ok,
  type Result,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

export type MemoryRecords = {
  define(input: MemoryRecordInput, signal?: AbortSignal): Result<MemoryRecord, MemoryError>;
  get(id: unknown): Result<MemoryRecord, MemoryError>;
};

export function createMemoryRecords(): MemoryRecords {
  const records = new Map<string, MemoryRecord>();

  return {
    define(input, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      if (typeof input.subject === "string" && containsRedactableSecret(input.subject)) {
        return err(memoryError("secret", "subject"));
      }
      if (typeof input.content === "string" && containsRedactableSecret(input.content)) {
        return err(memoryError("secret", "content"));
      }
      const defined = defineMemoryRecord(input);
      if (!defined.ok) {
        return defined;
      }
      if (records.has(defined.value.memoryId)) {
        return err(memoryError("conflict", "memoryId"));
      }
      records.set(defined.value.memoryId, defined.value);
      return defined;
    },
    get(id) {
      const parsed = memoryId.parse(id);
      if (!parsed.ok) {
        return err(memoryError("malformed", "memoryId"));
      }
      const record = records.get(parsed.value);
      if (record === undefined) {
        return err(memoryError("unavailable", "memoryId"));
      }
      return ok(record);
    },
  };
}
