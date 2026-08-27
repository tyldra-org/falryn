/** Durable memory-record storage added by migration 0005 (#788). */

import type { Migration } from "../domain/index.ts";

export const MEMORY_RECORDS_TABLE = "memory_records";
export const MEMORY_SCHEMA_VERSION = 5;

const CREATE_MEMORY_RECORDS = `CREATE TABLE ${MEMORY_RECORDS_TABLE} (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(memory_id) > 0),
  CHECK (workspace_id IS NULL OR length(workspace_id) > 0),
  CHECK (length(record_json) > 0),
  CHECK (length(created_at) > 0)
) STRICT`;

const CREATE_MEMORY_BY_WORKSPACE = `CREATE INDEX memory_records_by_workspace
  ON ${MEMORY_RECORDS_TABLE} (workspace_id, created_at DESC, memory_id)`;

export const MIGRATION_0005: Migration = {
  version: MEMORY_SCHEMA_VERSION,
  name: "create-memory-records",
  statements: [CREATE_MEMORY_RECORDS, CREATE_MEMORY_BY_WORKSPACE],
  destructive: false,
};
