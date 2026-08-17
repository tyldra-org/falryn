/**
 * Dedicated SQLite schema for rebuildable workspace indexes (#93).
 *
 * Separate from the product session database so indexes stay rebuildable
 * derivatives with their own migration sequence.
 */

import type { Migration } from "../domain/index.ts";

export const WORKSPACE_INDEX_GENERATIONS_TABLE = "workspace_index_generations";
export const WORKSPACE_INDEX_RECORDS_TABLE = "workspace_index_records";
export const WORKSPACE_INDEX_SCHEMA_VERSION = 1;

const CREATE_GENERATIONS = `CREATE TABLE ${WORKSPACE_INDEX_GENERATIONS_TABLE} (
  id TEXT PRIMARY KEY,
  schema TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(schema) > 0),
  CHECK (lifecycle IN (
    'absent','inventorying','building','ready','updating','stale','degraded','corrupt','unavailable'
  ))
) STRICT`;

const CREATE_RECORDS = `CREATE TABLE ${WORKSPACE_INDEX_RECORDS_TABLE} (
  generation_id TEXT NOT NULL REFERENCES ${WORKSPACE_INDEX_GENERATIONS_TABLE} (id) ON DELETE CASCADE,
  logical TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  revision TEXT NOT NULL,
  CHECK (kind IN ('symbol','heading','chunk')),
  CHECK (start_line >= 1),
  CHECK (end_line >= start_line),
  CHECK (length(logical) > 0),
  CHECK (length(revision) > 0)
) STRICT`;

const CREATE_RECORDS_BY_GENERATION = `CREATE INDEX workspace_index_records_generation
  ON ${WORKSPACE_INDEX_RECORDS_TABLE} (generation_id)`;

export const WORKSPACE_INDEX_MIGRATION_0001: Migration = {
  version: WORKSPACE_INDEX_SCHEMA_VERSION,
  name: "create-workspace-index",
  statements: [CREATE_GENERATIONS, CREATE_RECORDS, CREATE_RECORDS_BY_GENERATION],
  destructive: false,
};

export const WORKSPACE_INDEX_MIGRATIONS: readonly Migration[] = [WORKSPACE_INDEX_MIGRATION_0001];
