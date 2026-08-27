/**
 * The durable `EventStorePort`.
 *
 * This is the only implementation that survives a process exit;
 * `createInMemoryEventStore` stays a test double and is neither deleted,
 * weakened, nor promoted to a fallback. There is no second persistence
 * interface: durable storage answers the same two methods every other caller
 * already speaks.
 *
 * Four rules the implementation carries rather than documents:
 *
 * - **The database decides ordering and idempotency, not a cache.** Expected
 *   sequence, duplicate detection, and identifier conflicts are all read from
 *   stored rows *inside* the same `immediate` transaction that inserts, so the
 *   answer is the committed state and nothing can commit between the question
 *   and the write. Rehydrating an in-memory ledger at open was rejected: it is
 *   bounded, and a second Falryn process writing the same file would make any
 *   in-process cache stale in a way no test would catch.
 * - **The four applicable ordering codes are the whole vocabulary.** The
 *   conditions `UNIQUE (stream_id, sequence)`, `UNIQUE (stream_id,
 *   idempotency_key)`, and the event-identifier primary key protect are
 *   reported as `sequence-out-of-order`, `sequence-gap`,
 *   `idempotency-conflict`, and `event-id-conflict`.
 *   `ledger-capacity-exceeded` is an in-memory bound and is never emitted here,
 *   and no durable-only ordering code is invented.
 * - **The byte bound is enforced before the insert.** An oversized event is
 *   refused at append rather than written and then refused on the way back, so
 *   the store never holds a row it cannot read.
 * - **A row read back is untrusted input.** Every event goes through the same
 *   codec as one arriving from transport, so a hand-edited database cannot
 *   inject an unknown kind, a malformed identity, or an oversized payload into
 *   domain state.
 */

import {
  type AppendDecision,
  type AppendReceipt,
  type CodecIssue,
  type EventCursor,
  type EventStoreError,
  type EventStorePort,
  encodeRuntimeEvent,
  err,
  eventId,
  FIRST_SEQUENCE,
  fromStoredEvent,
  MAX_STREAM_READ_LIMIT,
  nextSequence,
  ok,
  type Result,
  type RuntimeEvent,
  type Sequence,
  type ShutdownParticipant,
  type SqliteRow,
  type SqliteStatements,
  type SqliteStoreError,
  type SqliteStorePort,
  type SqliteValue,
  type StoredEvent,
  type StreamId,
  sequence,
  streamId,
  toStoredEvent,
  traceId,
} from "../domain/index.ts";
import {
  EVENTS_TABLE,
  INVOCATIONS_TABLE,
  MODEL_ATTEMPTS_TABLE,
  SESSIONS_TABLE,
  TURNS_TABLE,
} from "./schema.ts";

/** The `persist-outcomes` participant's name, reported when it does not finish. */
export const EVENT_STORE_PARTICIPANT_NAME = "event-store";

const SELECT_LAST_SEQUENCE = `SELECT COALESCE(MAX(sequence), 0) AS lastSequence
  FROM ${EVENTS_TABLE} WHERE stream_id = $streamId`;

const SELECT_BY_IDEMPOTENCY_KEY = `SELECT event_id AS eventId, sequence AS sequence
  FROM ${EVENTS_TABLE} WHERE stream_id = $streamId AND idempotency_key = $idempotencyKey`;

const SELECT_EVENT_ID = `SELECT event_id AS eventId
  FROM ${EVENTS_TABLE} WHERE event_id = $eventId`;

const INSERT_EVENT = `INSERT INTO ${EVENTS_TABLE}
  (event_id, stream_id, sequence, kind, schema_version, occurred_at, trace_id,
   idempotency_key, payload)
  VALUES ($eventId, $streamId, $sequence, $kind, $schemaVersion, $occurredAt,
          $traceId, $idempotencyKey, $payload)`;

/** Project start identities in the same commit as their source event. */
function projectStartedRecord(statements: SqliteStatements, event: RuntimeEvent): void {
  switch (event.kind) {
    case "session.started":
      statements.run(
        `INSERT INTO ${SESSIONS_TABLE}
          (session_id, workspace_id, stream_id, title, configuration_generation,
           started_at, closed_at, outcome_kind, outcome_effect)
         VALUES ($sessionId, $workspaceId, $streamId, NULL, $configurationGeneration,
                 $startedAt, NULL, NULL, NULL)`,
        {
          sessionId: event.correlation.sessionId,
          workspaceId: event.correlation.workspaceId,
          streamId: event.streamId,
          configurationGeneration: event.correlation.configurationGeneration,
          startedAt: event.occurredAt,
        },
      );
      return;
    case "turn.started":
      statements.run(
        `INSERT INTO ${TURNS_TABLE}
          (turn_id, session_id, parent_turn_id, started_at, completed_at,
           outcome_kind, outcome_effect)
         VALUES ($turnId, $sessionId, NULL, $startedAt, NULL, NULL, NULL)`,
        {
          turnId: event.correlation.turnId,
          sessionId: event.correlation.sessionId,
          startedAt: event.occurredAt,
        },
      );
      return;
    case "model.attempt.started": {
      const binding = event.payload.binding;
      if (binding === undefined) {
        return;
      }
      statements.run(
        `INSERT INTO ${MODEL_ATTEMPTS_TABLE}
          (model_attempt_id, turn_id, provider_id, model_id, started_at,
           completed_at, outcome_kind, outcome_effect)
         VALUES ($modelAttemptId, $turnId, $providerId, $modelId, $startedAt,
                 NULL, NULL, NULL)`,
        {
          modelAttemptId: event.modelAttemptId,
          turnId: event.correlation.turnId,
          providerId: binding.providerId,
          modelId: binding.modelId,
          startedAt: event.occurredAt,
        },
      );
      return;
    }
    case "capability.invocation.started":
      if (
        event.payload.capabilityVersion === undefined ||
        event.payload.inputDigest === undefined
      ) {
        return;
      }
      statements.run(
        `INSERT INTO ${INVOCATIONS_TABLE}
          (invocation_id, turn_id, capability_id, capability_version, input_digest,
           started_at, completed_at, outcome_kind, outcome_effect)
         VALUES ($invocationId, $turnId, $capabilityId, $capabilityVersion, $inputDigest,
                 $startedAt, NULL, NULL, NULL)`,
        {
          invocationId: event.invocationId,
          turnId: event.correlation.turnId,
          capabilityId: event.capabilityId,
          capabilityVersion: event.payload.capabilityVersion,
          inputDigest: event.payload.inputDigest,
          startedAt: event.occurredAt,
        },
      );
      return;
    case "turn.completed":
    case "model.attempt.completed":
    case "capability.invocation.completed":
    case "configuration.generation.changed":
    case "execution.profile.selected":
      return;
  }
}

const EVENT_COLUMNS = `event_id AS eventId, stream_id AS aggregateId, sequence AS sequence,
  kind AS kind, schema_version AS schemaVersion, occurred_at AS occurredAt,
  trace_id AS traceId, payload AS payload`;

const SELECT_FROM_CURSOR = `SELECT ${EVENT_COLUMNS}
  FROM ${EVENTS_TABLE}
  WHERE stream_id = $streamId AND sequence > $afterSequence
  ORDER BY sequence
  LIMIT $limit`;

const SELECT_STREAM_HEADS = `SELECT stream_id AS streamId, MAX(sequence) AS lastSequence
  FROM ${EVENTS_TABLE} GROUP BY stream_id ORDER BY stream_id LIMIT $limit`;

/** The last sequence one stream holds. */
export type StreamHead = {
  readonly streamId: StreamId;
  readonly lastSequence: Sequence;
};

export type DurableEventStore = EventStorePort & {
  /**
   * Stops accepting appends and resolves once those in flight have settled.
   *
   * Idempotent. Reads keep working, because the projection checkpoint that runs
   * in the next shutdown phase has to be able to read what was just written.
   */
  quiesce(): Promise<void>;

  isAccepting(): boolean;

  /** Every stream holding at least one event, with the sequence it reached. */
  streamHeads(limit: number): Result<readonly StreamHead[], EventStoreError>;
};

export type SqliteEventStoreOptions = {
  /** Atomically materialize live start identities needed by artifact foreign keys. */
  readonly projectStartedRecords?: boolean;
};

function closedError(): SqliteStoreError {
  return {
    kind: "sqlite-store",
    code: "closed",
    operation: "transaction",
    effect: "none",
  };
}

/**
 * Places a store failure on the port's vocabulary.
 *
 * `cancelled` keeps the port's own code, because it means exactly what the
 * port's code means: the write did not commit. Everything else is carried
 * whole, because a caller diagnosing a full disk needs the operation and the
 * driver's own classification, not a summary of them.
 */
function eventStoreErrorFor(error: SqliteStoreError): EventStoreError {
  return error.code === "cancelled" ? { code: "cancelled" } : { code: "storage", error };
}

function malformedRow(path: string): { readonly issues: readonly CodecIssue[] } {
  return { issues: [{ path, code: "custom" }] };
}

type AppendResolution =
  | AppendDecision
  /** A stored row could not be read as the domain values it claims to hold. */
  | { readonly kind: "malformed-row"; readonly issues: readonly CodecIssue[] };

function textOf(value: SqliteValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function integerOf(value: SqliteValue | undefined): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : null;
}

/**
 * Decides an append against the committed rows, then performs it.
 *
 * Runs inside the caller's `immediate` transaction, which is what makes the
 * decision and the insert one indivisible step: another connection cannot
 * commit a conflicting row between the reads below and the write.
 */
function resolveAppend(
  statements: SqliteStatements,
  event: RuntimeEvent,
  projectRecords: boolean,
): AppendResolution {
  const recorded = statements.all(SELECT_BY_IDEMPOTENCY_KEY, {
    streamId: event.streamId,
    idempotencyKey: event.idempotencyKey,
  })[0];

  if (recorded !== undefined) {
    const recordedEventId = eventId.parse(textOf(recorded.eventId));
    const recordedSequence = sequence.parse(integerOf(recorded.sequence));
    if (!recordedEventId.ok || !recordedSequence.ok) {
      return { kind: "malformed-row", ...malformedRow("events.event_id") };
    }
    if (recordedEventId.value !== event.eventId) {
      // The key was used before by a different event. Reusing it is a producer
      // defect, and overwriting silently would lose one of the two facts.
      return {
        kind: "rejected",
        error: {
          code: "idempotency-conflict",
          streamId: event.streamId,
          idempotencyKey: event.idempotencyKey,
          recordedEventId: recordedEventId.value,
          observedEventId: event.eventId,
        },
      };
    }
    // Already stored. No second event is written and no failure is reported.
    return { kind: "duplicate", sequence: recordedSequence.value };
  }

  if (statements.all(SELECT_EVENT_ID, { eventId: event.eventId }).length > 0) {
    return {
      kind: "rejected",
      error: { code: "event-id-conflict", streamId: event.streamId, eventId: event.eventId },
    };
  }

  const lastSequence = integerOf(
    statements.all(SELECT_LAST_SEQUENCE, { streamId: event.streamId })[0]?.lastSequence,
  );
  if (lastSequence === null) {
    return { kind: "malformed-row", ...malformedRow("events.sequence") };
  }
  let expected = FIRST_SEQUENCE;
  if (lastSequence !== 0) {
    const highest = sequence.parse(lastSequence);
    if (!highest.ok) {
      return { kind: "malformed-row", ...malformedRow("events.sequence") };
    }
    expected = nextSequence(highest.value);
  }

  if (event.sequence < expected) {
    return {
      kind: "rejected",
      error: {
        code: "sequence-out-of-order",
        streamId: event.streamId,
        expectedSequence: expected,
        observedSequence: event.sequence,
      },
    };
  }
  if (event.sequence > expected) {
    return {
      kind: "rejected",
      error: {
        code: "sequence-gap",
        streamId: event.streamId,
        expectedSequence: expected,
        observedSequence: event.sequence,
      },
    };
  }

  const stored = toStoredEvent(event);
  if (projectRecords) {
    projectStartedRecord(statements, event);
  }
  statements.run(INSERT_EVENT, {
    eventId: stored.eventId,
    streamId: stored.aggregateId,
    sequence: stored.sequence,
    kind: stored.kind,
    schemaVersion: stored.schemaVersion,
    occurredAt: stored.occurredAt,
    traceId: stored.traceId,
    // A column so the database can enforce idempotency, and still present in
    // the payload, which stays the authority the event is rebuilt from.
    idempotencyKey: event.idempotencyKey,
    payload: JSON.stringify(stored.payload),
  });

  return { kind: "appended", sequence: event.sequence };
}

/** Rebuilds the persisted shape from a row, refusing anything that is not it. */
function storedEventFromRow(row: SqliteRow): Result<StoredEvent, readonly CodecIssue[]> {
  const identity = eventId.parse(textOf(row.eventId));
  if (!identity.ok) {
    return err([{ path: "eventId", code: "custom" }]);
  }
  const trace = traceId.parse(textOf(row.traceId));
  if (!trace.ok) {
    return err([{ path: "traceId", code: "custom" }]);
  }

  const aggregateId = textOf(row.aggregateId);
  const kind = textOf(row.kind);
  const occurredAt = textOf(row.occurredAt);
  const position = integerOf(row.sequence);
  const schemaVersion = integerOf(row.schemaVersion);
  const payloadText = textOf(row.payload);
  if (
    aggregateId === null ||
    kind === null ||
    occurredAt === null ||
    position === null ||
    schemaVersion === null ||
    payloadText === null
  ) {
    return err([{ path: "events", code: "invalid_type" }]);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return err([{ path: "payload", code: "invalid_type" }]);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return err([{ path: "payload", code: "invalid_type" }]);
  }

  return ok({
    eventId: identity.value,
    aggregateId,
    sequence: position,
    kind,
    schemaVersion,
    occurredAt,
    traceId: trace.value,
    payload: payload as Record<string, unknown>,
  });
}

export function createSqliteEventStore(
  store: SqliteStorePort,
  options: SqliteEventStoreOptions = {},
): DurableEventStore {
  let accepting = true;
  const inFlight = new Set<Promise<unknown>>();

  function performAppend(
    event: RuntimeEvent,
    signal?: AbortSignal,
  ): Result<AppendReceipt, EventStoreError> {
    // Encoded first: this both revalidates the event and enforces the 64 KiB
    // bound on the canonical form, so an event that could not be read back is
    // refused before a row exists for it.
    const encoded = encodeRuntimeEvent(event);
    if (!encoded.ok) {
      return err({ code: "codec", error: encoded.error });
    }

    const written = store.write(
      (statements) => resolveAppend(statements, event, options.projectStartedRecords === true),
      signal,
    );
    if (!written.ok) {
      return err(eventStoreErrorFor(written.error));
    }

    const resolution = written.value.value;
    const cancelledAfterCommit = written.value.cancelledAfterCommit;
    switch (resolution.kind) {
      case "malformed-row":
        return err({
          code: "codec",
          error: { kind: "invalid-envelope", issues: resolution.issues },
        });
      case "rejected":
        return err({ code: "sequence", error: resolution.error });
      case "duplicate":
        return ok({ kind: "duplicate", sequence: resolution.sequence, cancelledAfterCommit });
      case "appended":
        return ok({ kind: "appended", sequence: resolution.sequence, cancelledAfterCommit });
    }
  }

  return {
    async append(
      event: RuntimeEvent,
      signal?: AbortSignal,
    ): Promise<Result<AppendReceipt, EventStoreError>> {
      if (!accepting) {
        // Quiesced by the shutdown phase that precedes `close-storage`. A late
        // append is refused rather than racing the truncating checkpoint.
        return err({ code: "storage", error: closedError() });
      }
      const pending = Promise.resolve(performAppend(event, signal));
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },

    async readFrom(
      cursor: EventCursor,
      limit: number,
      signal?: AbortSignal,
    ): Promise<Result<readonly RuntimeEvent[], EventStoreError>> {
      if (signal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STREAM_READ_LIMIT) {
        return err({
          code: "invalid-read-limit",
          requestedLimit: limit,
          maximumLimit: MAX_STREAM_READ_LIMIT,
        });
      }

      const rows = store.read(SELECT_FROM_CURSOR, {
        streamId: cursor.streamId,
        afterSequence: cursor.afterSequence ?? 0,
        limit,
      });
      if (!rows.ok) {
        return err(eventStoreErrorFor(rows.error));
      }

      const events: RuntimeEvent[] = [];
      for (const row of rows.value) {
        const stored = storedEventFromRow(row);
        if (!stored.ok) {
          return err({ code: "codec", error: { kind: "invalid-envelope", issues: stored.error } });
        }
        const decoded = fromStoredEvent(stored.value);
        if (!decoded.ok) {
          return err({ code: "codec", error: decoded.error });
        }
        events.push(decoded.value);
      }
      return ok(events);
    },

    streamHeads(limit: number): Result<readonly StreamHead[], EventStoreError> {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        return err({ code: "invalid-read-limit", requestedLimit: limit, maximumLimit: limit });
      }
      const rows = store.read(SELECT_STREAM_HEADS, { limit });
      if (!rows.ok) {
        return err(eventStoreErrorFor(rows.error));
      }

      const heads: StreamHead[] = [];
      for (const row of rows.value) {
        const stream = streamId.parse(textOf(row.streamId));
        const last = sequence.parse(integerOf(row.lastSequence));
        if (!stream.ok || !last.ok) {
          return err({
            code: "codec",
            error: { kind: "invalid-envelope", issues: [{ path: "events", code: "custom" }] },
          });
        }
        heads.push({ streamId: stream.value, lastSequence: last.value });
      }
      return ok(heads);
    },

    async quiesce(): Promise<void> {
      accepting = false;
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },

    isAccepting: () => accepting,
  };
}

/**
 * The `persist-outcomes` participant.
 *
 * Real work, and ordering that matters: it stops accepting appends and awaits
 * the ones in flight, so the `close-storage` phase two steps later never runs
 * its truncating checkpoint against a statement that is still writing.
 */
export function createEventStoreShutdownParticipant(store: DurableEventStore): ShutdownParticipant {
  return {
    name: EVENT_STORE_PARTICIPANT_NAME,
    phase: "persist-outcomes",
    async run(): Promise<void> {
      await store.quiesce();
    },
  };
}
