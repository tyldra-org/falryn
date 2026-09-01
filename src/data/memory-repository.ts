/** SQLite repository for validated, bounded memory records (#788). */

import {
  defineMemoryRecord,
  err,
  type MemoryError,
  type MemoryRecord,
  type MemoryRecordInput,
  memoryScopeWorkspaceId,
  ok,
  type Result,
  type SqliteStorePort,
} from "../domain/index.ts";
import { MEMORY_RECORDS_TABLE } from "./memory-schema.ts";

export const MAX_DURABLE_MEMORY_RECORDS = 256;

export type MemoryRecordRepository = {
  load(): Result<readonly MemoryRecord[], MemoryError>;
  insert(record: MemoryRecord, signal?: AbortSignal): Result<null, MemoryError>;
};

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

function storedInput(record: MemoryRecord): MemoryRecordInput {
  return {
    memoryId: record.memoryId,
    schemaVersion: record.schemaVersion,
    generation: record.generation,
    scope: record.scope,
    kind: record.kind,
    subject: record.subject,
    content: record.content,
    provenance: record.provenance.map((entry) => ({
      origin: entry.origin,
      locator: entry.locator,
      ...(entry.eventId === null ? {} : { eventId: entry.eventId }),
    })),
    confidence: record.confidence,
    sensitivity: record.sensitivity,
    createdAt: record.createdAt,
    ...(record.reviewAfter === null ? {} : { reviewAfter: record.reviewAfter }),
    ...(record.expiresAt === null ? {} : { expiresAt: record.expiresAt }),
    supersedes: record.supersedes,
  };
}

function parseStoredRecord(value: unknown): Result<MemoryRecord, MemoryError> {
  if (typeof value !== "string") {
    return err(memoryError("malformed", "record_json"));
  }
  try {
    return defineMemoryRecord(JSON.parse(value) as MemoryRecordInput);
  } catch {
    return err(memoryError("malformed", "record_json"));
  }
}

export function createMemoryRecordRepository(store: SqliteStorePort): MemoryRecordRepository {
  return {
    load() {
      const rows = store.read(
        `SELECT record_json AS recordJson
           FROM ${MEMORY_RECORDS_TABLE}
          ORDER BY created_at DESC, memory_id ASC
          LIMIT $limit`,
        { limit: MAX_DURABLE_MEMORY_RECORDS },
      );
      if (!rows.ok) {
        return err(memoryError("unavailable", "storage"));
      }
      const records: MemoryRecord[] = [];
      for (const row of rows.value) {
        const parsed = parseStoredRecord(row.recordJson);
        if (!parsed.ok) {
          return parsed;
        }
        records.push(parsed.value);
      }
      return ok(records);
    },
    insert(record, signal) {
      const workspaceId = memoryScopeWorkspaceId(record.scope);
      const written = store.write((statements) => {
        const existing = statements.all(
          `SELECT memory_id FROM ${MEMORY_RECORDS_TABLE} WHERE memory_id = $memoryId`,
          { memoryId: record.memoryId },
        );
        if (existing.length > 0) {
          return "conflict" as const;
        }
        statements.run(
          `INSERT INTO ${MEMORY_RECORDS_TABLE}
            (memory_id, workspace_id, record_json, created_at)
           VALUES ($memoryId, $workspaceId, $recordJson, $createdAt)`,
          {
            memoryId: record.memoryId,
            workspaceId,
            recordJson: JSON.stringify(storedInput(record)),
            createdAt: record.createdAt,
          },
        );
        return "inserted" as const;
      }, signal);
      if (!written.ok) {
        return err(
          memoryError(written.error.code === "cancelled" ? "cancelled" : "unavailable", "storage"),
        );
      }
      return written.value.value === "conflict"
        ? err(memoryError("conflict", "memoryId"))
        : ok(null);
    },
  };
}
