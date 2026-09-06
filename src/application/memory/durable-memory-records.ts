/** Application adapter joining memory policy to durable record persistence (#788). */

import { err, memoryId, ok, type Result } from "../../domain/foundation/index.ts";
import {
  defineMemoryRecord,
  type MemoryError,
  type MemoryRecord,
  type MemoryRecordInput,
} from "../../domain/memory/index.ts";
import { containsRedactableSecret } from "../diagnostics/redaction.ts";
import type { MemoryRecords } from "./memory-record.ts";

export type MemoryPersistencePort = {
  load(): Result<readonly MemoryRecord[], MemoryError>;
  insert(record: MemoryRecord, signal?: AbortSignal): Result<null, MemoryError>;
};

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

/**
 * Restore committed memory records and persist every later admission before it
 * becomes visible to recall.
 */
export function createDurableMemoryRecords(
  persistence: MemoryPersistencePort,
): Result<MemoryRecords, MemoryError> {
  const loaded = persistence.load();
  if (!loaded.ok) {
    return loaded;
  }
  const records = new Map<string, MemoryRecord>();
  for (const record of loaded.value) {
    if (records.has(record.memoryId)) {
      return err(memoryError("conflict", "memoryId"));
    }
    records.set(record.memoryId, record);
  }

  return ok({
    define(input: MemoryRecordInput, signal?: AbortSignal) {
      if (signal?.aborted === true) {
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
      const persisted = persistence.insert(defined.value, signal);
      if (!persisted.ok) {
        return persisted;
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
      return record === undefined ? err(memoryError("unavailable", "memoryId")) : ok(record);
    },
    list() {
      return [...records.values()];
    },
  });
}
