/**
 * Migration `0004`: the artifact provenance graph.
 *
 * One `STRICT` table of parent transformations. It creates and indexes; it
 * alters no existing value, so it is non-destructive and the runner takes no
 * backup.
 *
 * Four decisions the SQL carries rather than documents:
 *
 * - **Edges live beside records, not on them.** A child may have several
 *   parents, and stuffing a JSON array onto `artifacts` would let a hand-edit
 *   invent a parent this build cannot refuse at the foreign key.
 * - **Both ends reference `artifacts`.** An edge cannot name a record that
 *   does not exist. Cycle detection stays in the domain: SQLite cannot
 *   express "this insert would close a loop".
 * - **The transformation column is a `CHECK`-constrained closed union.** The
 *   domain's three relations are the only values a row may hold.
 * - **The primary key is the whole edge.** A repeated link of the same
 *   child, parent, and relation is the same fact, not a second write.
 *
 * The statement list is the migration's identity: its checksum is recorded in
 * every database it is applied to, so editing a statement here after release is
 * refused rather than silently re-applied. A schema change is a new migration.
 */

import { ARTIFACT_TRANSFORMATIONS, type Migration } from "../domain/index.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";

export const ARTIFACT_TRANSFORMATIONS_TABLE = "artifact_transformations";

/** The schema version a database is at once migration `0004` has been applied. */
export const ARTIFACT_PROVENANCE_SCHEMA_VERSION = 4;

function quoted(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const CREATE_TRANSFORMATIONS = `CREATE TABLE ${ARTIFACT_TRANSFORMATIONS_TABLE} (
  child_artifact_id TEXT NOT NULL REFERENCES ${ARTIFACTS_TABLE} (artifact_id),
  parent_artifact_id TEXT NOT NULL REFERENCES ${ARTIFACTS_TABLE} (artifact_id),
  transformation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (child_artifact_id, parent_artifact_id, transformation),
  CHECK (child_artifact_id != parent_artifact_id),
  CHECK (transformation IN (${quoted(ARTIFACT_TRANSFORMATIONS)}))
) STRICT`;

const CREATE_BY_PARENT = `CREATE INDEX artifact_transformations_by_parent
  ON ${ARTIFACT_TRANSFORMATIONS_TABLE} (parent_artifact_id, created_at)`;

export const MIGRATION_0004: Migration = {
  version: ARTIFACT_PROVENANCE_SCHEMA_VERSION,
  name: "create-artifact-provenance",
  statements: [CREATE_TRANSFORMATIONS, CREATE_BY_PARENT],
  destructive: false,
};
