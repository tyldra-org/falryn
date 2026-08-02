/**
 * Migration `0001`: Falryn's first product schema.
 *
 * Six tables — sessions, turns, model attempts, invocations, events, and
 * projection cursors — plus only the indexes the reads in this area actually
 * perform. Every table is `STRICT`, so a column declared `INTEGER` cannot
 * quietly hold the string `"1"` and be read back as one.
 *
 * Four decisions the SQL carries rather than documents:
 *
 * - **The database is the ordering and idempotency authority.**
 *   `UNIQUE (stream_id, sequence)` and `UNIQUE (stream_id, idempotency_key)`
 *   are what make per-stream monotonicity and idempotent re-append survive a
 *   restart. An in-memory ledger cannot: it is bounded, and a second Falryn
 *   process writing the same file would make any in-process cache stale in a
 *   way no test would catch.
 * - **There is no `workspaces` table.** A session carries `workspace_id` as an
 *   identity column with no foreign key. The workspace record is owned by
 *   another slice, and `foreign_keys = ON` means a key pointing at a table this
 *   migration does not create would either block every session write or force a
 *   stub row invented to satisfy it.
 * - **`events` has no foreign key either.** A stream is not a session — a
 *   stream may be appended to before any record describes it — so events are
 *   keyed by their stream and joined to a session through `sessions.stream_id`,
 *   which is unique for exactly that reason.
 * - **An outcome is two constrained columns.** Kind and effect certainty stay
 *   queryable and bounded by `CHECK` rather than hidden inside a blob, and the
 *   completion time and the outcome are constrained to appear together, so a
 *   row can never be half-terminal.
 *
 * The statement list is the migration's identity: its checksum is recorded in
 * every database it is applied to, so editing a statement here after release is
 * refused rather than silently re-applied. A schema change is a new migration.
 */

import type { Migration } from "../domain/index.ts";

export const SESSIONS_TABLE = "sessions";
export const TURNS_TABLE = "turns";
export const MODEL_ATTEMPTS_TABLE = "model_attempts";
export const INVOCATIONS_TABLE = "invocations";
export const EVENTS_TABLE = "events";
export const PROJECTION_CURSORS_TABLE = "projection_cursors";

/** Every table migration `0001` creates, in creation order. */
export const RECORD_TABLES: readonly string[] = [
  SESSIONS_TABLE,
  TURNS_TABLE,
  MODEL_ATTEMPTS_TABLE,
  INVOCATIONS_TABLE,
  EVENTS_TABLE,
  PROJECTION_CURSORS_TABLE,
];

/** The schema version a database is at once migration `0001` has been applied. */
export const RECORD_SCHEMA_VERSION = 1;

const CREATE_SESSIONS = `CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL UNIQUE,
  title TEXT,
  configuration_generation INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  closed_at TEXT,
  outcome_kind TEXT,
  outcome_effect TEXT,
  CHECK (configuration_generation >= 0),
  CHECK (outcome_kind IS NULL OR outcome_kind IN
    ('completed', 'failed', 'cancelled', 'timed-out', 'uncertain')),
  CHECK (outcome_effect IS NULL OR outcome_effect IN
    ('none', 'completed', 'partial', 'uncertain')),
  CHECK ((closed_at IS NULL) = (outcome_kind IS NULL)),
  CHECK ((outcome_kind IS NULL) = (outcome_effect IS NULL))
) STRICT`;

const CREATE_TURNS = `CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  parent_turn_id TEXT REFERENCES turns (turn_id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome_kind TEXT,
  outcome_effect TEXT,
  CHECK (parent_turn_id IS NULL OR parent_turn_id <> turn_id),
  CHECK (outcome_kind IS NULL OR outcome_kind IN
    ('completed', 'failed', 'cancelled', 'timed-out', 'uncertain')),
  CHECK (outcome_effect IS NULL OR outcome_effect IN
    ('none', 'completed', 'partial', 'uncertain')),
  CHECK ((completed_at IS NULL) = (outcome_kind IS NULL)),
  CHECK ((outcome_kind IS NULL) = (outcome_effect IS NULL))
) STRICT`;

const CREATE_MODEL_ATTEMPTS = `CREATE TABLE model_attempts (
  model_attempt_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns (turn_id),
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome_kind TEXT,
  outcome_effect TEXT,
  CHECK (outcome_kind IS NULL OR outcome_kind IN
    ('completed', 'failed', 'cancelled', 'timed-out', 'uncertain')),
  CHECK (outcome_effect IS NULL OR outcome_effect IN
    ('none', 'completed', 'partial', 'uncertain')),
  CHECK ((completed_at IS NULL) = (outcome_kind IS NULL)),
  CHECK ((outcome_kind IS NULL) = (outcome_effect IS NULL))
) STRICT`;

const CREATE_INVOCATIONS = `CREATE TABLE invocations (
  invocation_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns (turn_id),
  capability_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  input_digest TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  outcome_kind TEXT,
  outcome_effect TEXT,
  CHECK (capability_version >= 1),
  CHECK (outcome_kind IS NULL OR outcome_kind IN
    ('completed', 'failed', 'cancelled', 'timed-out', 'uncertain')),
  CHECK (outcome_effect IS NULL OR outcome_effect IN
    ('none', 'completed', 'partial', 'uncertain')),
  CHECK ((completed_at IS NULL) = (outcome_kind IS NULL)),
  CHECK ((outcome_kind IS NULL) = (outcome_effect IS NULL))
) STRICT`;

const CREATE_EVENTS = `CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (stream_id, sequence),
  UNIQUE (stream_id, idempotency_key),
  CHECK (sequence >= 1),
  CHECK (schema_version >= 1)
) STRICT`;

const CREATE_PROJECTION_CURSORS = `CREATE TABLE projection_cursors (
  projection TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_applied_sequence INTEGER,
  schema_generation INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (projection, stream_id),
  CHECK (last_applied_sequence IS NULL OR last_applied_sequence >= 1),
  CHECK (schema_generation >= 1)
) STRICT`;

/**
 * The indexes the reads in this area perform, and no others.
 *
 * Every listing is by parent in start order, so each index is the parent column
 * followed by the sort column. The event reads need no index of their own:
 * `UNIQUE (stream_id, sequence)` already serves both the cursor read and the
 * per-stream maximum the checkpoint pass takes.
 */
const CREATE_SESSIONS_BY_WORKSPACE =
  "CREATE INDEX sessions_by_workspace ON sessions (workspace_id, started_at)";
const CREATE_TURNS_BY_SESSION = "CREATE INDEX turns_by_session ON turns (session_id, started_at)";
const CREATE_MODEL_ATTEMPTS_BY_TURN =
  "CREATE INDEX model_attempts_by_turn ON model_attempts (turn_id, started_at)";
const CREATE_INVOCATIONS_BY_TURN =
  "CREATE INDEX invocations_by_turn ON invocations (turn_id, started_at)";

/**
 * Creates tables and indexes only.
 *
 * Non-destructive by construction, so the runner takes no pre-migration backup:
 * a first run has nothing to lose, and a database at version 0 holds no product
 * row this step could alter.
 */
export const MIGRATION_0001: Migration = {
  version: RECORD_SCHEMA_VERSION,
  name: "create-session-turn-and-event-records",
  statements: [
    CREATE_SESSIONS,
    CREATE_TURNS,
    CREATE_MODEL_ATTEMPTS,
    CREATE_INVOCATIONS,
    CREATE_EVENTS,
    CREATE_PROJECTION_CURSORS,
    CREATE_SESSIONS_BY_WORKSPACE,
    CREATE_TURNS_BY_SESSION,
    CREATE_MODEL_ATTEMPTS_BY_TURN,
    CREATE_INVOCATIONS_BY_TURN,
  ],
  destructive: false,
};
