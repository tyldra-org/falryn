/**
 * Migration `0003`: run identity, and the artifact's link to the run that
 * wrote it.
 *
 * One `STRICT` table plus one added column plus one partial index. It creates
 * and adds; it alters no existing value, so it is non-destructive and the
 * runner takes no backup.
 *
 * Four decisions the SQL carries rather than documents:
 *
 * - **A missing `ended_at` is the crash signal.** The row is inserted at
 *   startup and stamped during shutdown, so the absence of an end time is the
 *   durable trace of a run that never got there. Nothing else in this schema
 *   can distinguish an abandoned write from one another process is still
 *   making.
 * - **`artifacts.run_id` is nullable, and by necessity.** `ALTER TABLE ... ADD
 *   COLUMN` can only add a column whose default is `NULL`, and rows written
 *   under migration `0002` predate every run, so there is no value to
 *   backfill. A null run means "no run can still be writing this", which is
 *   exactly what a pre-`0003` row is.
 * - **The index is partial.** Recovery reads reserved artifacts and nothing
 *   else, and in an ordinary database almost every row is `available`, so an
 *   index over the whole column would be mostly dead weight. `WHERE
 *   availability = 'reserved'` indexes the handful of rows the one read
 *   actually visits.
 * - **No index on `runs`.** The table is read whole — every run this database
 *   has seen is a bounded list, and the pass needs all of it to decide
 *   attribution — so an index would serve no read that happens.
 *
 * The statement list is the migration's identity: its checksum is recorded in
 * every database it is applied to, so editing a statement here after release is
 * refused rather than silently re-applied. A schema change is a new migration.
 */

import type { Migration } from "../domain/index.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";

export const RUNS_TABLE = "runs";

/** The schema version a database is at once migration `0003` has been applied. */
export const RUN_SCHEMA_VERSION = 3;

const CREATE_RUNS = `CREATE TABLE ${RUNS_TABLE} (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  schema_version INTEGER NOT NULL,
  CHECK (schema_version >= 1)
) STRICT`;

const ADD_ARTIFACT_RUN = `ALTER TABLE ${ARTIFACTS_TABLE}
  ADD COLUMN run_id TEXT REFERENCES ${RUNS_TABLE} (run_id)`;

const CREATE_RESERVED_ARTIFACTS = `CREATE INDEX artifacts_reserved
  ON ${ARTIFACTS_TABLE} (run_id) WHERE availability = 'reserved'`;

export const MIGRATION_0003: Migration = {
  version: RUN_SCHEMA_VERSION,
  name: "create-run-identity",
  statements: [CREATE_RUNS, ADD_ARTIFACT_RUN, CREATE_RESERVED_ARTIFACTS],
  destructive: false,
};
