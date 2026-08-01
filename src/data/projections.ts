/**
 * The projection cursor store and the runner that moves it.
 *
 * A projection is derived state plus the position it was derived from, and both
 * move together: every page of events is applied and its cursor written inside
 * one `immediate` transaction, so a cursor can never claim work a rolled-back
 * transaction did not do, and a crash between two pages resumes at the page
 * boundary rather than re-applying or skipping one.
 *
 * The `terminal-outcomes` projection derives one thing: when a turn, model
 * attempt, or capability invocation ended and how. That is a genuine projection
 * — the events are the facts, the record columns are the interpretation — and
 * it is entirely a function of stored events. It performs no provider call, no
 * network request, no filesystem read, and no tool lookup, which is what makes
 * drop-and-rebuild reproduce identical state.
 *
 * Catch-up is paged rather than whole-stream. One transaction stays short by
 * construction, and a stream longer than memory is still projectable.
 */

import {
  type ClockPort,
  type EventCursor,
  err,
  MAX_CHECKPOINTED_STREAMS,
  ok,
  PROJECTION_PAGE_SIZE,
  type ProjectionCheckpointReport,
  type ProjectionCursor,
  type ProjectionError,
  type ProjectionRunReport,
  parseProjectionCursor,
  type RecordCompletion,
  type Result,
  reduceCompletions,
  type Sequence,
  type ShutdownParticipant,
  type SqliteStatements,
  type SqliteStorePort,
  type StreamId,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
  type Timestamp,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import type { DurableEventStore } from "./event-store.ts";
import { applyCompletion } from "./repositories.ts";
import {
  INVOCATIONS_TABLE,
  MODEL_ATTEMPTS_TABLE,
  PROJECTION_CURSORS_TABLE,
  SESSIONS_TABLE,
  TURNS_TABLE,
} from "./schema.ts";

/** The `checkpoint-projections` participant's name. */
export const PROJECTION_PARTICIPANT_NAME = "projection-cursors";

/** The one projection this build maintains. */
const PROJECTION = "terminal-outcomes";

const SELECT_CURSOR = `SELECT projection AS projection, stream_id AS streamId,
  last_applied_sequence AS lastAppliedSequence, schema_generation AS schemaGeneration,
  updated_at AS updatedAt
  FROM ${PROJECTION_CURSORS_TABLE}
  WHERE projection = $projection AND stream_id = $streamId`;

const UPSERT_CURSOR = `INSERT INTO ${PROJECTION_CURSORS_TABLE}
  (projection, stream_id, last_applied_sequence, schema_generation, updated_at)
  VALUES ($projection, $streamId, $lastAppliedSequence, $schemaGeneration, $updatedAt)
  ON CONFLICT (projection, stream_id) DO UPDATE SET
    last_applied_sequence = excluded.last_applied_sequence,
    schema_generation = excluded.schema_generation,
    updated_at = excluded.updated_at`;

const DELETE_CURSOR = `DELETE FROM ${PROJECTION_CURSORS_TABLE}
  WHERE projection = $projection AND stream_id = $streamId`;

/**
 * Clearing the derived state a rebuild is about to reproduce.
 *
 * Scoped through `sessions.stream_id`, which is unique, because a stream is
 * what a cursor is keyed by and a session is what the records hang from. Only
 * the derived columns are cleared: identity, parentage, and start time are
 * facts a producer wrote, not this projection's to reset.
 */
const CLEAR_TURNS = `UPDATE ${TURNS_TABLE}
  SET completed_at = NULL, outcome_kind = NULL, outcome_effect = NULL
  WHERE session_id IN
    (SELECT session_id FROM ${SESSIONS_TABLE} WHERE stream_id = $streamId)`;

const CLEAR_MODEL_ATTEMPTS = `UPDATE ${MODEL_ATTEMPTS_TABLE}
  SET completed_at = NULL, outcome_kind = NULL, outcome_effect = NULL
  WHERE turn_id IN
    (SELECT turn_id FROM ${TURNS_TABLE} WHERE session_id IN
      (SELECT session_id FROM ${SESSIONS_TABLE} WHERE stream_id = $streamId))`;

const CLEAR_INVOCATIONS = `UPDATE ${INVOCATIONS_TABLE}
  SET completed_at = NULL, outcome_kind = NULL, outcome_effect = NULL
  WHERE turn_id IN
    (SELECT turn_id FROM ${TURNS_TABLE} WHERE session_id IN
      (SELECT session_id FROM ${SESSIONS_TABLE} WHERE stream_id = $streamId))`;

export type ProjectionRunnerOptions = {
  readonly store: SqliteStorePort;
  readonly events: DurableEventStore;
  readonly clock: ClockPort;
};

export type ProjectionRunner = {
  readCursor(streamId: StreamId): Result<ProjectionCursor | null, ProjectionError>;

  /**
   * Applies every event a stream holds beyond its cursor.
   *
   * A cursor recorded under a different reducer generation describes state this
   * build did not produce, so it is rebuilt rather than resumed from.
   */
  advance(
    streamId: StreamId,
    signal?: AbortSignal,
  ): Promise<Result<ProjectionRunReport, ProjectionError>>;

  /** Drops the derived state and its cursor, then derives both again. */
  rebuild(
    streamId: StreamId,
    signal?: AbortSignal,
  ): Promise<Result<ProjectionRunReport, ProjectionError>>;

  /** Brings every stream holding events up to date. */
  checkpoint(signal?: AbortSignal): Promise<Result<ProjectionCheckpointReport, ProjectionError>>;
};

function storageError(error: ProjectionErrorSource): ProjectionError {
  return { kind: "projection", code: "storage", error };
}

type ProjectionErrorSource = Extract<ProjectionError, { code: "storage" }>["error"];

/** Writes a cursor inside the caller's transaction, beside the state it describes. */
function writeCursor(statements: SqliteStatements, cursor: ProjectionCursor): void {
  statements.run(UPSERT_CURSOR, {
    projection: cursor.projection,
    streamId: cursor.streamId,
    lastAppliedSequence: cursor.lastAppliedSequence,
    schemaGeneration: cursor.schemaGeneration,
    updatedAt: cursor.updatedAt,
  });
}

type PageOutcome = {
  readonly applied: number;
  readonly unmatched: number;
};

function applyPage(
  statements: SqliteStatements,
  completions: readonly RecordCompletion[],
  cursor: ProjectionCursor,
): PageOutcome {
  let applied = 0;
  let unmatched = 0;
  for (const completion of completions) {
    if (applyCompletion(statements, completion)) {
      applied += 1;
    } else {
      unmatched += 1;
    }
  }
  // Written last and in the same transaction: the cursor is only true once the
  // state it describes is.
  writeCursor(statements, cursor);
  return { applied, unmatched };
}

export function createProjectionRunner(options: ProjectionRunnerOptions): ProjectionRunner {
  const { store, events, clock } = options;

  const now = (): Timestamp => timestampFromEpochMilliseconds(clock.now());

  const readCursor = (streamId: StreamId): Result<ProjectionCursor | null, ProjectionError> => {
    const rows = store.read(SELECT_CURSOR, { projection: PROJECTION, streamId });
    if (!rows.ok) {
      return err(storageError(rows.error));
    }
    const row = rows.value[0];
    if (row === undefined) {
      return ok(null);
    }
    const parsed = parseProjectionCursor(row);
    return parsed.ok
      ? ok(parsed.value)
      : err({ kind: "projection", code: "malformed-cursor", issues: parsed.error });
  };

  const advanceFrom = async (
    streamId: StreamId,
    from: Sequence | null,
    signal: AbortSignal | undefined,
  ): Promise<Result<ProjectionRunReport, ProjectionError>> => {
    let after = from;
    let eventsRead = 0;
    let applied = 0;
    let unmatched = 0;
    let stopped = false;

    for (;;) {
      if (signal?.aborted === true) {
        stopped = true;
        break;
      }

      const cursor: EventCursor = { streamId, afterSequence: after };
      const page = await events.readFrom(cursor, PROJECTION_PAGE_SIZE);
      if (!page.ok) {
        return err({ kind: "projection", code: "events", error: page.error });
      }
      const batch = page.value;
      if (batch.length === 0) {
        break;
      }

      const last = batch[batch.length - 1];
      if (last === undefined) {
        break;
      }
      const advanced: ProjectionCursor = {
        projection: PROJECTION,
        streamId,
        lastAppliedSequence: last.sequence,
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
        updatedAt: now(),
      };
      const completions = reduceCompletions(batch);

      const written = store.write((statements) => applyPage(statements, completions, advanced));
      if (!written.ok) {
        return err(storageError(written.error));
      }
      applied += written.value.value.applied;
      unmatched += written.value.value.unmatched;
      eventsRead += batch.length;
      after = last.sequence;

      if (batch.length < PROJECTION_PAGE_SIZE) {
        break;
      }
    }

    return ok({
      projection: PROJECTION,
      streamId,
      eventsRead,
      applied,
      unmatched,
      lastAppliedSequence: after,
      stopped,
    });
  };

  const clear = (streamId: StreamId): Result<null, ProjectionError> => {
    const written = store.write((statements) => {
      statements.run(CLEAR_TURNS, { streamId });
      statements.run(CLEAR_MODEL_ATTEMPTS, { streamId });
      statements.run(CLEAR_INVOCATIONS, { streamId });
      // Dropped in the same transaction as the state it described, so a crash
      // here cannot leave a cursor claiming state that is no longer there.
      statements.run(DELETE_CURSOR, { projection: PROJECTION, streamId });
    });
    return written.ok ? ok(null) : err(storageError(written.error));
  };

  const rebuild = async (
    streamId: StreamId,
    signal?: AbortSignal,
  ): Promise<Result<ProjectionRunReport, ProjectionError>> => {
    const cleared = clear(streamId);
    if (!cleared.ok) {
      return err(cleared.error);
    }
    return advanceFrom(streamId, null, signal);
  };

  return {
    readCursor,

    async advance(
      streamId: StreamId,
      signal?: AbortSignal,
    ): Promise<Result<ProjectionRunReport, ProjectionError>> {
      const cursor = readCursor(streamId);
      if (!cursor.ok) {
        return err(cursor.error);
      }
      if (
        cursor.value !== null &&
        cursor.value.schemaGeneration !== TERMINAL_OUTCOME_PROJECTION_GENERATION
      ) {
        return rebuild(streamId, signal);
      }
      return advanceFrom(streamId, cursor.value?.lastAppliedSequence ?? null, signal);
    },

    rebuild,

    async checkpoint(
      signal?: AbortSignal,
    ): Promise<Result<ProjectionCheckpointReport, ProjectionError>> {
      // One over the bound, so the report can say it stopped short rather than
      // presenting a truncated pass as a complete one.
      const heads = events.streamHeads(MAX_CHECKPOINTED_STREAMS + 1);
      if (!heads.ok) {
        return err({ kind: "projection", code: "events", error: heads.error });
      }
      const truncated = heads.value.length > MAX_CHECKPOINTED_STREAMS;
      const visiting = truncated ? heads.value.slice(0, MAX_CHECKPOINTED_STREAMS) : heads.value;

      const runs: ProjectionRunReport[] = [];
      for (const head of visiting) {
        if (signal?.aborted === true) {
          break;
        }
        const cursor = readCursor(head.streamId);
        if (!cursor.ok) {
          return err(cursor.error);
        }
        if (
          cursor.value !== null &&
          cursor.value.schemaGeneration === TERMINAL_OUTCOME_PROJECTION_GENERATION &&
          cursor.value.lastAppliedSequence === head.lastSequence
        ) {
          // Already current. A phase that ticks by rewriting an unchanged
          // cursor would be doing nothing while reporting that it did.
          continue;
        }
        const run = await advanceFrom(
          head.streamId,
          cursor.value?.schemaGeneration === TERMINAL_OUTCOME_PROJECTION_GENERATION
            ? (cursor.value?.lastAppliedSequence ?? null)
            : null,
          signal,
        );
        if (!run.ok) {
          return err(run.error);
        }
        runs.push(run.value);
      }

      return ok({ runs, truncated });
    },
  };
}

/**
 * The `checkpoint-projections` participant.
 *
 * Runs after `persist-outcomes` has stopped accepting appends, so the stream it
 * catches up to is the stream that will be there after shutdown, and before
 * `close-storage`, so its writes land while the database is still open.
 */
export function createProjectionShutdownParticipant(runner: ProjectionRunner): ShutdownParticipant {
  return {
    name: PROJECTION_PARTICIPANT_NAME,
    phase: "checkpoint-projections",
    async run(context): Promise<void> {
      const checkpointed = await runner.checkpoint(context.signal);
      if (!checkpointed.ok) {
        throw new Error(`the projection checkpoint did not complete: ${checkpointed.error.code}`);
      }
    },
  };
}
