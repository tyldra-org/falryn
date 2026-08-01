/**
 * Typed repositories for Falryn's durable records.
 *
 * Every repository answers the same four questions — insert one, complete one,
 * read one, list a parent's — and returns domain records. No column name, row
 * object, statement, or database handle appears in anything they hand back,
 * which is what lets the storage shape change without a provider, a renderer,
 * or an agent path noticing.
 *
 * Three rules the implementation carries rather than documents:
 *
 * - **One table description, not four repositories.** The four differ only in
 *   their columns and in which column records completion. Writing the same
 *   transaction shape four times is how two of them drift.
 * - **Existence is decided inside the write transaction.** Inserting a record
 *   that is already stored and completing one that is not are both answered
 *   from the committed rows in the same `immediate` transaction that writes, so
 *   a caller gets `already-exists` or `not-found` rather than a constraint
 *   violation it would have to interpret. Neither rejection writes anything, so
 *   neither needs a rollback to undo.
 * - **Every row read back is parsed.** A record leaves this module only after
 *   its identities, timestamps, and terminal outcome have been validated, so a
 *   hand-edited database is rejected at the boundary rather than admitted into
 *   domain state. The rejection reports a path and an issue code and never the
 *   rejected value.
 */

import {
  type CodecIssue,
  type EventStoreError,
  type EventStorePort,
  effectOf,
  err,
  type InvocationId,
  type InvocationRecord,
  MAX_RECORD_LIST_LIMIT,
  MAX_STREAM_READ_LIMIT,
  type ModelAttemptId,
  type ModelAttemptRecord,
  ok,
  outcomeFromColumns,
  parseInvocationRecord,
  parseModelAttemptRecord,
  parseSessionRecord,
  parseTurnRecord,
  type RecordCompletion,
  type RecordCompletionInput,
  type RecordEntity,
  type RecordError,
  type RecordRepositories,
  type RecordRepositoryPort,
  type RecordWrite,
  type Result,
  type SessionId,
  type SessionRecord,
  type SessionView,
  type SqliteBindings,
  type SqliteRow,
  type SqliteStatements,
  type SqliteStoreError,
  type SqliteStorePort,
  type TerminalOutcome,
  type TurnId,
  type TurnRecord,
  type TurnView,
  type WorkspaceId,
} from "../domain/index.ts";
import { INVOCATIONS_TABLE, MODEL_ATTEMPTS_TABLE, SESSIONS_TABLE, TURNS_TABLE } from "./schema.ts";

/** How one table is read, written, completed, and parsed. */
type TableSpec<Record> = {
  readonly entity: RecordEntity;
  readonly table: string;
  readonly idColumn: string;
  readonly parentColumn: string;
  /** The column a terminal record records its end time in. */
  readonly completedColumn: string;
  /** `column AS field` for every column, so a row arrives with record keys. */
  readonly selectList: string;
  readonly insert: string;
  bindingsFor(record: Record): SqliteBindings;
  identityOf(record: Record): string;
  parse(value: unknown): Result<Record, readonly CodecIssue[]>;
};

/** The lifecycle columns every record shares, spelled once. */
const LIFECYCLE_COLUMNS = "outcome_kind AS outcomeKind, outcome_effect AS outcomeEffect";

type OutcomeBindings = {
  readonly outcomeKind: string | null;
  readonly outcomeEffect: string | null;
};

/**
 * Splits an outcome into the two values a store keeps it in.
 *
 * The effect is written even for `completed`, whose effect the domain leaves
 * implied, so the two columns are always both present or both absent and the
 * schema can constrain them as a pair.
 */
function outcomeBindings(outcome: TerminalOutcome | null): OutcomeBindings {
  return outcome === null
    ? { outcomeKind: null, outcomeEffect: null }
    : { outcomeKind: outcome.kind, outcomeEffect: effectOf(outcome) };
}

/**
 * Presents a row as the shape its parser expects.
 *
 * The two outcome columns become the one closed union the domain declares, so a
 * parser sees the record shape a caller gets rather than a third,
 * storage-specific one.
 */
function withOutcome(row: SqliteRow): Record<string, unknown> {
  const { outcomeKind, outcomeEffect, ...rest } = row;
  return { ...rest, outcome: outcomeFromColumns(outcomeKind ?? null, outcomeEffect ?? null) };
}

const sessionSpec: TableSpec<SessionRecord> = {
  entity: "session",
  table: SESSIONS_TABLE,
  idColumn: "session_id",
  parentColumn: "workspace_id",
  completedColumn: "closed_at",
  selectList: `session_id AS sessionId, workspace_id AS workspaceId, stream_id AS streamId,
    title AS title, configuration_generation AS configurationGeneration,
    started_at AS startedAt, closed_at AS closedAt, ${LIFECYCLE_COLUMNS}`,
  insert: `INSERT INTO ${SESSIONS_TABLE}
    (session_id, workspace_id, stream_id, title, configuration_generation,
     started_at, closed_at, outcome_kind, outcome_effect)
    VALUES ($sessionId, $workspaceId, $streamId, $title, $configurationGeneration,
            $startedAt, $completedAt, $outcomeKind, $outcomeEffect)`,
  bindingsFor: (record) => ({
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    streamId: record.streamId,
    title: record.title,
    configurationGeneration: record.configurationGeneration,
    startedAt: record.startedAt,
    completedAt: record.closedAt,
    ...outcomeBindings(record.outcome),
  }),
  identityOf: (record) => record.sessionId,
  parse: parseSessionRecord,
};

const turnSpec: TableSpec<TurnRecord> = {
  entity: "turn",
  table: TURNS_TABLE,
  idColumn: "turn_id",
  parentColumn: "session_id",
  completedColumn: "completed_at",
  selectList: `turn_id AS turnId, session_id AS sessionId, parent_turn_id AS parentTurnId,
    started_at AS startedAt, completed_at AS completedAt, ${LIFECYCLE_COLUMNS}`,
  insert: `INSERT INTO ${TURNS_TABLE}
    (turn_id, session_id, parent_turn_id, started_at, completed_at,
     outcome_kind, outcome_effect)
    VALUES ($turnId, $sessionId, $parentTurnId, $startedAt, $completedAt,
            $outcomeKind, $outcomeEffect)`,
  bindingsFor: (record) => ({
    turnId: record.turnId,
    sessionId: record.sessionId,
    parentTurnId: record.parentTurnId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    ...outcomeBindings(record.outcome),
  }),
  identityOf: (record) => record.turnId,
  parse: parseTurnRecord,
};

const modelAttemptSpec: TableSpec<ModelAttemptRecord> = {
  entity: "model-attempt",
  table: MODEL_ATTEMPTS_TABLE,
  idColumn: "model_attempt_id",
  parentColumn: "turn_id",
  completedColumn: "completed_at",
  selectList: `model_attempt_id AS modelAttemptId, turn_id AS turnId,
    provider_id AS providerId, model_id AS modelId, started_at AS startedAt,
    completed_at AS completedAt, ${LIFECYCLE_COLUMNS}`,
  insert: `INSERT INTO ${MODEL_ATTEMPTS_TABLE}
    (model_attempt_id, turn_id, provider_id, model_id, started_at, completed_at,
     outcome_kind, outcome_effect)
    VALUES ($modelAttemptId, $turnId, $providerId, $modelId, $startedAt, $completedAt,
            $outcomeKind, $outcomeEffect)`,
  bindingsFor: (record) => ({
    modelAttemptId: record.modelAttemptId,
    turnId: record.turnId,
    providerId: record.providerId,
    modelId: record.modelId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    ...outcomeBindings(record.outcome),
  }),
  identityOf: (record) => record.modelAttemptId,
  parse: parseModelAttemptRecord,
};

const invocationSpec: TableSpec<InvocationRecord> = {
  entity: "invocation",
  table: INVOCATIONS_TABLE,
  idColumn: "invocation_id",
  parentColumn: "turn_id",
  completedColumn: "completed_at",
  selectList: `invocation_id AS invocationId, turn_id AS turnId,
    capability_id AS capabilityId, capability_version AS capabilityVersion,
    input_digest AS inputDigest, started_at AS startedAt,
    completed_at AS completedAt, ${LIFECYCLE_COLUMNS}`,
  insert: `INSERT INTO ${INVOCATIONS_TABLE}
    (invocation_id, turn_id, capability_id, capability_version, input_digest,
     started_at, completed_at, outcome_kind, outcome_effect)
    VALUES ($invocationId, $turnId, $capabilityId, $capabilityVersion, $inputDigest,
            $startedAt, $completedAt, $outcomeKind, $outcomeEffect)`,
  bindingsFor: (record) => ({
    invocationId: record.invocationId,
    turnId: record.turnId,
    capabilityId: record.capabilityId,
    capabilityVersion: record.capabilityVersion,
    inputDigest: record.inputDigest,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    ...outcomeBindings(record.outcome),
  }),
  identityOf: (record) => record.invocationId,
  parse: parseInvocationRecord,
};

/**
 * The one statement that moves a record to its terminal state.
 *
 * Built here so the repository and the projection that derives the same
 * columns from events run identical SQL. Two spellings of this update would be
 * two answers to what "completed" means in a row.
 */
function completeStatement(target: CompletionTarget): string {
  return `UPDATE ${target.table}
    SET ${target.completedColumn} = $completedAt, outcome_kind = $outcomeKind,
        outcome_effect = $outcomeEffect
    WHERE ${target.idColumn} = $id`;
}

/** The three column facts completing a record needs, independent of its shape. */
type CompletionTarget = {
  readonly table: string;
  readonly idColumn: string;
  readonly completedColumn: string;
};

/** Structural on purpose: every `TableSpec` already carries these three. */
function completionTarget(spec: CompletionTarget): CompletionTarget {
  return { table: spec.table, idColumn: spec.idColumn, completedColumn: spec.completedColumn };
}

const COMPLETION_TARGETS: {
  readonly [Entity in RecordCompletion["entity"]]: CompletionTarget;
} = {
  turn: completionTarget(turnSpec),
  "model-attempt": completionTarget(modelAttemptSpec),
  invocation: completionTarget(invocationSpec),
};

function completionIdentity(completion: RecordCompletion): string {
  switch (completion.entity) {
    case "turn":
      return completion.turnId;
    case "model-attempt":
      return completion.modelAttemptId;
    case "invocation":
      return completion.invocationId;
  }
}

/**
 * Applies one derived completion inside a caller's transaction.
 *
 * Returns whether it matched a record. A completion naming a record this
 * database does not hold is reported rather than failed: an event is a fact,
 * and a stream whose records were never written is a gap to see, not a reason
 * to stop projecting.
 */
export function applyCompletion(
  statements: SqliteStatements,
  completion: RecordCompletion,
): boolean {
  const outcome = outcomeBindings(completion.outcome);
  const changed = statements.run(completeStatement(COMPLETION_TARGETS[completion.entity]), {
    id: completionIdentity(completion),
    completedAt: completion.completedAt,
    outcomeKind: outcome.outcomeKind,
    outcomeEffect: outcome.outcomeEffect,
  });
  return changed.changes > 0;
}

function storageError(entity: RecordEntity, error: SqliteStoreError): RecordError {
  return { kind: "record", code: "storage", entity, error };
}

function malformedRow(entity: RecordEntity, issues: readonly CodecIssue[]): RecordError {
  return { kind: "record", code: "malformed-row", entity, issues };
}

function createRepository<Record, Id extends string, ParentId extends string>(
  store: SqliteStorePort,
  spec: TableSpec<Record>,
): RecordRepositoryPort<Record, Id, ParentId> {
  const selectById = `SELECT ${spec.selectList} FROM ${spec.table} WHERE ${spec.idColumn} = $id`;
  const selectExisting = `SELECT ${spec.idColumn} AS id FROM ${spec.table}
    WHERE ${spec.idColumn} = $id`;
  const selectByParent = `SELECT ${spec.selectList} FROM ${spec.table}
    WHERE ${spec.parentColumn} = $parentId
    ORDER BY started_at, ${spec.idColumn}
    LIMIT $limit`;
  const completeOne = completeStatement(completionTarget(spec));

  /**
   * Runs one write and folds its two failure sources into one answer.
   *
   * The work returns a rejection rather than throwing, because neither
   * rejection this module raises has written anything by the time it is
   * decided — there is nothing for a rollback to undo, and a throw would arrive
   * at the boundary as an unclassifiable statement failure.
   */
  const write = (
    work: (statements: SqliteStatements) => RecordError | null,
    signal: AbortSignal | undefined,
  ): Result<RecordWrite, RecordError> => {
    const written = store.write(work, signal);
    if (!written.ok) {
      return err(storageError(spec.entity, written.error));
    }
    const rejection = written.value.value;
    return rejection === null
      ? ok({ cancelledAfterCommit: written.value.cancelledAfterCommit })
      : err(rejection);
  };

  const parseRow = (row: SqliteRow): Result<Record, RecordError> => {
    const parsed = spec.parse(withOutcome(row));
    return parsed.ok ? ok(parsed.value) : err(malformedRow(spec.entity, parsed.error));
  };

  return {
    insert(record: Record, signal?: AbortSignal): Result<RecordWrite, RecordError> {
      return write((statements) => {
        const identity = spec.identityOf(record);
        if (statements.all(selectExisting, { id: identity }).length > 0) {
          return { kind: "record", code: "already-exists", entity: spec.entity, identity };
        }
        statements.run(spec.insert, spec.bindingsFor(record));
        return null;
      }, signal);
    },

    complete(
      id: Id,
      completion: RecordCompletionInput,
      signal?: AbortSignal,
    ): Result<RecordWrite, RecordError> {
      return write((statements) => {
        const outcome = outcomeBindings(completion.outcome);
        const changed = statements.run(completeOne, {
          id,
          completedAt: completion.completedAt,
          outcomeKind: outcome.outcomeKind,
          outcomeEffect: outcome.outcomeEffect,
        });
        return changed.changes === 0
          ? { kind: "record", code: "not-found", entity: spec.entity, identity: id }
          : null;
      }, signal);
    },

    get(id: Id): Result<Record | null, RecordError> {
      const rows = store.read(selectById, { id });
      if (!rows.ok) {
        return err(storageError(spec.entity, rows.error));
      }
      const row = rows.value[0];
      return row === undefined ? ok(null) : parseRow(row);
    },

    listByParent(parentId: ParentId, limit: number): Result<readonly Record[], RecordError> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_LIST_LIMIT) {
        return err({
          kind: "record",
          code: "invalid-list-limit",
          entity: spec.entity,
          requestedLimit: limit,
          maximumLimit: MAX_RECORD_LIST_LIMIT,
        });
      }
      const rows = store.read(selectByParent, { parentId, limit });
      if (!rows.ok) {
        return err(storageError(spec.entity, rows.error));
      }
      const records: Record[] = [];
      for (const row of rows.value) {
        const parsed = parseRow(row);
        if (!parsed.ok) {
          return err(parsed.error);
        }
        records.push(parsed.value);
      }
      return ok(records);
    },
  };
}

/** Every repository over one open database. */
export function createRecordRepositories(store: SqliteStorePort): RecordRepositories {
  return {
    sessions: createRepository<SessionRecord, SessionId, WorkspaceId>(store, sessionSpec),
    turns: createRepository<TurnRecord, TurnId, SessionId>(store, turnSpec),
    modelAttempts: createRepository<ModelAttemptRecord, ModelAttemptId, TurnId>(
      store,
      modelAttemptSpec,
    ),
    invocations: createRepository<InvocationRecord, InvocationId, TurnId>(store, invocationSpec),
  };
}

/** How much of a session one view may gather. */
export type SessionViewLimits = {
  readonly turns: number;
  readonly perTurn: number;
  readonly events: number;
};

export const DEFAULT_SESSION_VIEW_LIMITS: SessionViewLimits = {
  turns: 200,
  perTurn: 200,
  events: MAX_STREAM_READ_LIMIT,
};

/**
 * Reads one session, its turns, and its events into the shared view shape.
 *
 * Every read is bounded and the view says so when a bound stopped it, rather
 * than presenting a partial session as a whole one. It performs no write, so a
 * renderer calling it cannot change what it is describing.
 */
export async function readSessionView(
  repositories: RecordRepositories,
  events: EventStorePort,
  sessionId: SessionId,
  limits: SessionViewLimits = DEFAULT_SESSION_VIEW_LIMITS,
): Promise<Result<SessionView | null, RecordError | EventStoreError>> {
  const session = repositories.sessions.get(sessionId);
  if (!session.ok) {
    return err(session.error);
  }
  if (session.value === null) {
    return ok(null);
  }

  const turns = repositories.turns.listByParent(sessionId, limits.turns);
  if (!turns.ok) {
    return err(turns.error);
  }

  const views: TurnView[] = [];
  for (const turn of turns.value) {
    const attempts = repositories.modelAttempts.listByParent(turn.turnId, limits.perTurn);
    if (!attempts.ok) {
      return err(attempts.error);
    }
    const invocations = repositories.invocations.listByParent(turn.turnId, limits.perTurn);
    if (!invocations.ok) {
      return err(invocations.error);
    }
    views.push({ turn, modelAttempts: attempts.value, invocations: invocations.value });
  }

  const stream = await events.readFrom(
    { streamId: session.value.streamId, afterSequence: null },
    limits.events,
  );
  if (!stream.ok) {
    return err(stream.error);
  }

  return ok({
    session: session.value,
    turns: views,
    events: stream.value,
    truncated:
      turns.value.length === limits.turns ||
      stream.value.length === limits.events ||
      views.some(
        (view) =>
          view.modelAttempts.length === limits.perTurn ||
          view.invocations.length === limits.perTurn,
      ),
  });
}
