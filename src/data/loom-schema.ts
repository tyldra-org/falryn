/** Durable Loom-manifest storage added by migration 0006 (#788). */

import type { Migration } from "../domain/index.ts";

export const LOOM_MANIFESTS_TABLE = "loom_manifests";
export const LOOM_SCHEMA_VERSION = 6;

const CREATE_LOOM_MANIFESTS = `CREATE TABLE ${LOOM_MANIFESTS_TABLE} (
  manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(manifest_id) > 0),
  CHECK (length(workspace_id) > 0),
  CHECK (length(session_id) > 0),
  CHECK (length(manifest_json) > 0)
) STRICT`;

const CREATE_LOOM_BY_SCOPE = `CREATE INDEX loom_manifests_by_scope
  ON ${LOOM_MANIFESTS_TABLE} (workspace_id, session_id, created_at DESC, manifest_id)`;

export const MIGRATION_0006: Migration = {
  version: LOOM_SCHEMA_VERSION,
  name: "create-loom-manifests",
  statements: [CREATE_LOOM_MANIFESTS, CREATE_LOOM_BY_SCOPE],
  destructive: false,
};
