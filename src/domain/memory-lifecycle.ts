/**
 * Memory correction, supersession, deletion, and retention (#112).
 *
 * Corrections create a new identity with supersession links and never rewrite
 * the old record. Deletion records a receipt naming retained artifacts or
 * exports. Expiry is an overlay; the canonical record is not mutated.
 * Operational learning and product tools remain later.
 */

import { timestampSchema } from "./branded-schema.ts";
import { type MemoryId, memoryId } from "./identity.ts";
import {
  defineMemoryRecord,
  MEMORY_RECORD_VERSION,
  type MemoryError,
  type MemoryRecord,
  type MemoryRecordInput,
} from "./memory-record.ts";
import { err, ok, type Result } from "./result.ts";
import type { Timestamp } from "./time.ts";
import { timestampToEpochMilliseconds } from "./time.ts";

export const MEMORY_LIFECYCLE_VERSION = "memory-lifecycle.v1";
export const MAX_MEMORY_RETAINED = 16;
export const MAX_MEMORY_RETAINED_LOCATOR_BYTES = 256;

export const MEMORY_RETAINED_KINDS = ["artifact", "export"] as const;
export type MemoryRetainedKind = (typeof MEMORY_RETAINED_KINDS)[number];

export type MemoryRetainedHandle = {
  readonly kind: MemoryRetainedKind;
  readonly locator: string;
};

export type MemoryDeletion = {
  readonly schemaVersion: typeof MEMORY_LIFECYCLE_VERSION;
  readonly memoryId: MemoryId;
  readonly deletedAt: Timestamp;
  readonly retained: readonly MemoryRetainedHandle[];
};

export type MemoryCorrectionInput = {
  readonly current?: unknown;
  readonly replacement?: unknown;
  readonly cancelled?: unknown;
};

export type MemoryDeletionInput = {
  readonly memoryId?: unknown;
  readonly deletedAt?: unknown;
  readonly retained?: unknown;
  readonly cancelled?: unknown;
};

export type MemoryExpiryInput = {
  readonly current?: unknown;
  readonly expiresAt?: unknown;
  readonly cancelled?: unknown;
};

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

function asRecord(value: unknown, field: string): Result<MemoryRecord, MemoryError> {
  if (value === null || typeof value !== "object") {
    return err(memoryError("malformed", field));
  }
  if (
    "schemaVersion" in value &&
    value.schemaVersion === MEMORY_RECORD_VERSION &&
    "memoryId" in value &&
    "scope" in value &&
    "kind" in value
  ) {
    return ok(value as MemoryRecord);
  }
  return defineMemoryRecord(value as MemoryRecordInput);
}

function parseRetained(value: unknown): Result<readonly MemoryRetainedHandle[], MemoryError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", "retained"));
  }
  if (value.length > MAX_MEMORY_RETAINED) {
    return err(memoryError("oversized", "retained"));
  }
  const retained: MemoryRetainedHandle[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object") {
      return err(memoryError("malformed", `retained.${index}`));
    }
    const kind = (entry as { kind?: unknown }).kind;
    const locator = (entry as { locator?: unknown }).locator;
    if (kind !== "artifact" && kind !== "export") {
      return err(memoryError("malformed", `retained.${index}.kind`));
    }
    if (typeof locator !== "string" || locator.length === 0 || locator.includes("\0")) {
      return err(memoryError("malformed", `retained.${index}.locator`));
    }
    if (locator.length > MAX_MEMORY_RETAINED_LOCATOR_BYTES) {
      return err(memoryError("oversized", `retained.${index}.locator`));
    }
    retained.push({ kind, locator });
  }
  return ok(retained);
}

/**
 * Builds a superseding record. The current record is not rewritten.
 */
export function planMemoryCorrection(
  input: MemoryCorrectionInput,
): Result<MemoryRecord, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const current = asRecord(input.current, "current");
  if (!current.ok) {
    return current;
  }
  if (input.replacement === null || typeof input.replacement !== "object") {
    return err(memoryError("malformed", "replacement"));
  }
  const replacementId = memoryId.parse((input.replacement as { memoryId?: unknown }).memoryId);
  if (!replacementId.ok) {
    return err(memoryError("malformed", "memoryId"));
  }
  if (replacementId.value === current.value.memoryId) {
    return err(memoryError("conflict", "memoryId"));
  }
  const replacement = defineMemoryRecord(input.replacement as MemoryRecordInput);
  if (!replacement.ok) {
    return replacement;
  }
  if (!replacement.value.supersedes.includes(current.value.memoryId)) {
    return err(memoryError("malformed", "supersedes"));
  }
  if (replacement.value.generation <= current.value.generation) {
    return err(memoryError("malformed", "generation"));
  }
  if (replacement.value.kind !== "correction" && replacement.value.kind !== current.value.kind) {
    return err(memoryError("malformed", "kind"));
  }
  return ok(replacement.value);
}

/**
 * Records a deletion receipt. Canonical bytes stay; recall must omit the id.
 */
export function planMemoryDeletion(
  input: MemoryDeletionInput,
): Result<MemoryDeletion, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const id = memoryId.parse(input.memoryId);
  if (!id.ok) {
    return err(memoryError("malformed", "memoryId"));
  }
  const deletedAt = timestampSchema.safeParse(input.deletedAt);
  if (!deletedAt.success) {
    return err(memoryError("malformed", "deletedAt"));
  }
  const retained = parseRetained(input.retained);
  if (!retained.ok) {
    return retained;
  }
  return ok({
    schemaVersion: MEMORY_LIFECYCLE_VERSION,
    memoryId: id.value,
    deletedAt: deletedAt.data,
    retained: retained.value,
  });
}

/**
 * Validates an expiry overlay. The canonical record is not rewritten.
 */
export function planMemoryExpiry(input: MemoryExpiryInput): Result<Timestamp, MemoryError> {
  if (input.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const current = asRecord(input.current, "current");
  if (!current.ok) {
    return current;
  }
  const expiresAt = timestampSchema.safeParse(input.expiresAt);
  if (!expiresAt.success) {
    return err(memoryError("malformed", "expiresAt"));
  }
  if (
    timestampToEpochMilliseconds(expiresAt.data) <
    timestampToEpochMilliseconds(current.value.createdAt)
  ) {
    return err(memoryError("stale", "expiresAt"));
  }
  return ok(expiresAt.data);
}

export function projectExpiredRecord(record: MemoryRecord, expiresAt: Timestamp): MemoryRecord {
  return { ...record, expiresAt };
}
