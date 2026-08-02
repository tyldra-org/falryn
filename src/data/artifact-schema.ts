/**
 * Migration `0002`: the artifact metadata table.
 *
 * One `STRICT` table beside the record tables migration `0001` created, plus
 * the two indexes the reads in this area actually perform. It creates a table
 * and its indexes and alters nothing, so it is non-destructive and the runner
 * takes no backup.
 *
 * Four decisions the SQL carries rather than documents:
 *
 * - **`invocation_id` is nullable and is the only foreign key here.** Bytes can
 *   be ingested before any invocation claims them — a capture, an imported
 *   file, a diagnostic taken outside a turn — and with `foreign_keys = ON` a
 *   non-null key to a row that may not exist is a write nobody can perform.
 * - **Sensitivity, availability, origin, and encoding are `CHECK`-constrained
 *   unions.** Each is a closed union in the domain, and a column that could
 *   hold a fifth value is a column this build would read back and refuse.
 * - **Finalized time and availability are constrained as a pair.** `reserved`
 *   is exactly the state with no finalized time, so no row can be
 *   half-finalized — the same shape the record tables use for completion time
 *   and terminal outcome.
 * - **The digest is indexed and is not unique.** Deduplicating exact bytes is a
 *   read this area performs, and two artifacts with distinct lineage are
 *   allowed to share one digest; a unique index would make the second one
 *   unwritable.
 *
 * The statement list is the migration's identity: its checksum is recorded in
 * every database it is applied to, so editing a statement here after release is
 * refused rather than silently re-applied. A schema change is a new migration.
 */

import {
  ARTIFACT_AVAILABILITIES,
  ARTIFACT_ENCODINGS,
  ARTIFACT_ORIGINS,
  ARTIFACT_SENSITIVITIES,
  type Migration,
} from "../domain/index.ts";

export const ARTIFACTS_TABLE = "artifacts";

/** The schema version a database is at once migration `0002` has been applied. */
export const ARTIFACT_SCHEMA_VERSION = 2;

/** `'a', 'b', 'c'` — a closed union spelled once, from the domain's own list. */
function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const CREATE_ARTIFACTS = `CREATE TABLE ${ARTIFACTS_TABLE} (
  artifact_id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  encoding TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  sensitivity TEXT NOT NULL,
  origin TEXT NOT NULL,
  invocation_id TEXT REFERENCES invocations (invocation_id),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  availability TEXT NOT NULL,
  CHECK (byte_length >= 0),
  CHECK (encoding IN (${quoted(ARTIFACT_ENCODINGS)})),
  CHECK (origin IN (${quoted(ARTIFACT_ORIGINS)})),
  CHECK (sensitivity IN (${quoted(ARTIFACT_SENSITIVITIES)})),
  CHECK (availability IN (${quoted(ARTIFACT_AVAILABILITIES)})),
  CHECK ((finalized_at IS NULL) = (availability = 'reserved'))
) STRICT`;

/**
 * Deduplication reads by digest; an invocation's artifacts read by invocation.
 *
 * Both are the parent column followed by the sort column, matching every other
 * listing in this schema, so a listing is an index scan rather than a sort over
 * a table scan.
 */
const CREATE_ARTIFACTS_BY_DIGEST = `CREATE INDEX artifacts_by_digest ON ${ARTIFACTS_TABLE} (digest, created_at)`;

const CREATE_ARTIFACTS_BY_INVOCATION = `CREATE INDEX artifacts_by_invocation ON ${ARTIFACTS_TABLE} (invocation_id, created_at)`;

export const MIGRATION_0002: Migration = {
  version: ARTIFACT_SCHEMA_VERSION,
  name: "create-artifact-metadata",
  statements: [CREATE_ARTIFACTS, CREATE_ARTIFACTS_BY_DIGEST, CREATE_ARTIFACTS_BY_INVOCATION],
  destructive: false,
};
