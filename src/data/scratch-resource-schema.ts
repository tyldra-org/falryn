/** Durable session scratch resources added by migration 0009 (#848). */

import type { Migration } from "../domain/index.ts";

export const SCRATCH_RESOURCES_TABLE = "scratch_resources";
export const SCRATCH_REVISIONS_TABLE = "scratch_resource_revisions";
export const SCRATCH_RESOURCE_SCHEMA_VERSION = 9;

const CREATE_SCRATCH_RESOURCES = `CREATE TABLE ${SCRATCH_RESOURCES_TABLE} (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, name),
  CHECK (length(name) > 0),
  CHECK (status IN ('active', 'discarded')),
  CHECK (current_revision >= 1),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
) STRICT`;

const CREATE_SCRATCH_REVISIONS = `CREATE TABLE ${SCRATCH_REVISIONS_TABLE} (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id),
  digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  invocation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, name, revision),
  FOREIGN KEY (session_id, name)
    REFERENCES ${SCRATCH_RESOURCES_TABLE} (session_id, name) ON DELETE CASCADE,
  CHECK (revision >= 1),
  CHECK (length(digest) > 0),
  CHECK (length(media_type) > 0),
  CHECK (byte_length >= 0),
  CHECK (length(invocation_id) > 0),
  CHECK (created_at >= 0)
) STRICT`;

const CREATE_SCRATCH_RESOURCES_BY_SESSION = `CREATE INDEX scratch_resources_by_session
  ON ${SCRATCH_RESOURCES_TABLE} (session_id, updated_at DESC, name)`;

const CREATE_SCRATCH_REVISIONS_BY_ARTIFACT = `CREATE INDEX scratch_revisions_by_artifact
  ON ${SCRATCH_REVISIONS_TABLE} (artifact_id)`;

export const MIGRATION_0009: Migration = {
  version: SCRATCH_RESOURCE_SCHEMA_VERSION,
  name: "add-artifact-backed-session-scratch-resources",
  statements: [
    CREATE_SCRATCH_RESOURCES,
    CREATE_SCRATCH_REVISIONS,
    CREATE_SCRATCH_RESOURCES_BY_SESSION,
    CREATE_SCRATCH_REVISIONS_BY_ARTIFACT,
  ],
  destructive: false,
};
