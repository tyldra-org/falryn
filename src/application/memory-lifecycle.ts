/**
 * Application boundary for memory correction, deletion, and retention (#112).
 *
 * Canonical records are never rewritten. Deletion receipts and expiry overlays
 * sit beside them. Recall should use `listActive`. Product tools remain later.
 */

import {
  err,
  type MemoryDeletion,
  type MemoryError,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemoryRetainedHandle,
  memoryId,
  ok,
  planMemoryCorrection,
  planMemoryDeletion,
  planMemoryExpiry,
  projectExpiredRecord,
  type Result,
  type Timestamp,
} from "../domain/index.ts";
import { createMemoryRecords, type MemoryRecords } from "./memory-record.ts";
import { containsRedactableSecret } from "./redaction.ts";

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

export type MemoryLifecycle = {
  correct(
    currentId: unknown,
    replacement: MemoryRecordInput,
    signal?: AbortSignal,
  ): Result<MemoryRecord, MemoryError>;
  delete(
    currentId: unknown,
    deletedAt: unknown,
    retained?: readonly MemoryRetainedHandle[],
    signal?: AbortSignal,
  ): Result<MemoryDeletion, MemoryError>;
  expire(
    currentId: unknown,
    expiresAt: unknown,
    signal?: AbortSignal,
  ): Result<Timestamp, MemoryError>;
  deletion(id: unknown): Result<MemoryDeletion, MemoryError>;
  list(): readonly MemoryRecord[];
  listActive(): readonly MemoryRecord[];
};

export function createMemoryLifecycle(
  records: MemoryRecords = createMemoryRecords(),
): MemoryLifecycle {
  const deletions = new Map<string, MemoryDeletion>();
  const expiries = new Map<string, Timestamp>();

  const listActive = (): readonly MemoryRecord[] => {
    const active: MemoryRecord[] = [];
    for (const record of records.list()) {
      if (deletions.has(record.memoryId)) {
        continue;
      }
      const overlay = expiries.get(record.memoryId);
      active.push(overlay === undefined ? record : projectExpiredRecord(record, overlay));
    }
    return active;
  };

  return {
    correct(currentId, replacement, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      if (
        typeof replacement.subject === "string" &&
        containsRedactableSecret(replacement.subject)
      ) {
        return err(memoryError("secret", "subject"));
      }
      if (
        typeof replacement.content === "string" &&
        containsRedactableSecret(replacement.content)
      ) {
        return err(memoryError("secret", "content"));
      }
      const current = records.get(currentId);
      if (!current.ok) {
        return current;
      }
      if (deletions.has(current.value.memoryId)) {
        return err(memoryError("denied", "memoryId"));
      }
      const planned = planMemoryCorrection({ current: current.value, replacement });
      if (!planned.ok) {
        return planned;
      }
      return records.define(replacement);
    },
    delete(currentId, deletedAt, retained, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      const current = records.get(currentId);
      if (!current.ok) {
        return current;
      }
      if (deletions.has(current.value.memoryId)) {
        return err(memoryError("conflict", "memoryId"));
      }
      const planned = planMemoryDeletion({
        memoryId: current.value.memoryId,
        deletedAt,
        retained,
      });
      if (!planned.ok) {
        return planned;
      }
      deletions.set(planned.value.memoryId, planned.value);
      return planned;
    },
    expire(currentId, expiresAt, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      const current = records.get(currentId);
      if (!current.ok) {
        return current;
      }
      if (deletions.has(current.value.memoryId)) {
        return err(memoryError("denied", "memoryId"));
      }
      const planned = planMemoryExpiry({ current: current.value, expiresAt });
      if (!planned.ok) {
        return planned;
      }
      expiries.set(current.value.memoryId, planned.value);
      return planned;
    },
    deletion(id) {
      const parsed = memoryId.parse(id);
      if (!parsed.ok) {
        return err(memoryError("malformed", "memoryId"));
      }
      const receipt = deletions.get(parsed.value);
      if (receipt === undefined) {
        return err(memoryError("unavailable", "memoryId"));
      }
      return ok(receipt);
    },
    list: listActive,
    listActive,
  };
}
