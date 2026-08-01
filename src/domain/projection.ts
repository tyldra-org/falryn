/**
 * Projection cursors and the one reducer this build derives state with.
 *
 * A projection is derived state plus the position it was derived from. The
 * cursor is that position: which projection, which stream, the last sequence it
 * applied, the reducer generation that produced it, and when it moved. It
 * advances in the same transaction as the state it describes, so a cursor can
 * never claim work that a rolled-back transaction did not do.
 *
 * The reducer here is a pure function of stored events and nothing else. It
 * performs no provider call, no network request, no filesystem read, and no
 * tool lookup, which is what makes drop-and-rebuild produce identical state
 * rather than a second, differently-informed answer.
 *
 * This module owns the cursor and the reducer. A projection registry, a
 * transcript view, and a viewer are owned elsewhere; declaring a registry here
 * to hold one projection would be a framework built for a single caller.
 */

import { z } from "zod";

import { brandedInteger, brandedString, timestampSchema, toCodecIssues } from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import type { RuntimeEvent } from "./event.ts";
import type { EventStoreError } from "./event-store.ts";
import {
  type InvocationId,
  type ModelAttemptId,
  type Sequence,
  type StreamId,
  sequence,
  streamId,
  type TurnId,
} from "./identity.ts";
import type { TerminalOutcome } from "./outcome.ts";
import { err, ok, type Result } from "./result.ts";
import type { SqliteStoreError } from "./sqlite.ts";
import type { Timestamp } from "./time.ts";

/**
 * The projections this build maintains.
 *
 * A closed union rather than a free string: an unknown name in a cursor row is
 * a defect, and a set this small does not need a registry to describe it.
 */
export const PROJECTION_NAMES = ["terminal-outcomes"] as const;

export type ProjectionName = (typeof PROJECTION_NAMES)[number];

export function isProjectionName(value: unknown): value is ProjectionName {
  return typeof value === "string" && (PROJECTION_NAMES as readonly string[]).includes(value);
}

/**
 * The reducer generation behind the `terminal-outcomes` projection.
 *
 * Raised when the reducer's output for the same events would change. A cursor
 * recorded under an older generation describes state this build did not
 * produce, so it is rebuilt rather than resumed.
 */
export const TERMINAL_OUTCOME_PROJECTION_GENERATION = 1;

/**
 * Events applied per transaction while catching a projection up.
 *
 * Small enough that one transaction stays short, large enough that catching up
 * a long stream is not one transaction per event.
 */
export const PROJECTION_PAGE_SIZE = 256;

/** Streams one checkpoint pass will visit. A run with more is already a defect. */
export const MAX_CHECKPOINTED_STREAMS = 1_024;

export type ProjectionCursor = {
  readonly projection: ProjectionName;
  readonly streamId: StreamId;
  /** Highest sequence applied, or `null` when nothing has been applied yet. */
  readonly lastAppliedSequence: Sequence | null;
  readonly schemaGeneration: number;
  readonly updatedAt: Timestamp;
};

const projectionCursorSchema: z.ZodType<ProjectionCursor> = z.object({
  projection: z.literal(PROJECTION_NAMES),
  streamId: brandedString(streamId),
  lastAppliedSequence: brandedInteger(sequence).nullable(),
  schemaGeneration: z.int().min(1),
  updatedAt: timestampSchema,
});

/**
 * Validates a stored cursor.
 *
 * A cursor is untrusted input like any other row: one naming a projection this
 * build does not have, or a sequence that is not one, describes state this
 * build cannot reason about and is refused rather than resumed from.
 */
export function parseProjectionCursor(
  value: unknown,
): Result<ProjectionCursor, readonly CodecIssue[]> {
  const parsed = projectionCursorSchema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(toCodecIssues(parsed.error));
}

/** Every way maintaining a projection fails. */
export type ProjectionError =
  | { readonly kind: "projection"; readonly code: "storage"; readonly error: SqliteStoreError }
  | {
      readonly kind: "projection";
      readonly code: "malformed-cursor";
      readonly issues: readonly CodecIssue[];
    }
  /** The events a rebuild reads from could not be read. */
  | { readonly kind: "projection"; readonly code: "events"; readonly error: EventStoreError };

/**
 * One record reaching its terminal state, derived from one event.
 *
 * Discriminated by entity so the identifier a completion carries is the one
 * that entity is keyed by, rather than a shared string field that any of the
 * three could be read out of.
 */
export type RecordCompletion =
  | {
      readonly entity: "turn";
      readonly turnId: TurnId;
      readonly completedAt: Timestamp;
      readonly outcome: TerminalOutcome;
    }
  | {
      readonly entity: "model-attempt";
      readonly modelAttemptId: ModelAttemptId;
      readonly completedAt: Timestamp;
      readonly outcome: TerminalOutcome;
    }
  | {
      readonly entity: "invocation";
      readonly invocationId: InvocationId;
      readonly completedAt: Timestamp;
      readonly outcome: TerminalOutcome;
    };

/**
 * Derives terminal-state updates from an ordered run of events.
 *
 * Pure and total: the same events always produce the same completions in the
 * same order, and an event that says nothing about a terminal state produces
 * none. Completions are returned in event order and applied in that order, so a
 * later fact about the same record supersedes an earlier one without this
 * function having to decide which fact is newer.
 */
export function reduceCompletions(events: readonly RuntimeEvent[]): readonly RecordCompletion[] {
  const completions: RecordCompletion[] = [];
  for (const event of events) {
    const completion = completionFor(event);
    if (completion !== null) {
      completions.push(completion);
    }
  }
  return completions;
}

function completionFor(event: RuntimeEvent): RecordCompletion | null {
  switch (event.kind) {
    case "turn.completed":
      return {
        entity: "turn",
        turnId: event.correlation.turnId,
        completedAt: event.occurredAt,
        outcome: event.payload.outcome,
      };
    case "model.attempt.completed":
      return {
        entity: "model-attempt",
        modelAttemptId: event.modelAttemptId,
        completedAt: event.occurredAt,
        outcome: event.payload.outcome,
      };
    case "capability.invocation.completed":
      return {
        entity: "invocation",
        invocationId: event.invocationId,
        completedAt: event.occurredAt,
        outcome: event.payload.outcome,
      };
    default:
      return null;
  }
}

/** What one catch-up pass over one stream did. */
export type ProjectionRunReport = {
  readonly projection: ProjectionName;
  readonly streamId: StreamId;
  readonly eventsRead: number;
  /** Completions that updated a record. */
  readonly applied: number;
  /**
   * Completions naming a record this database does not hold.
   *
   * Reported rather than failed: an event is a fact, and a stream whose records
   * were never written is a gap to see, not a reason to stop projecting.
   */
  readonly unmatched: number;
  readonly lastAppliedSequence: Sequence | null;
  /** Whether cancellation ended the pass before the stream did. */
  readonly stopped: boolean;
};

/** What one `checkpoint-projections` pass did, across every stream it visited. */
export type ProjectionCheckpointReport = {
  readonly runs: readonly ProjectionRunReport[];
  /** Whether {@link MAX_CHECKPOINTED_STREAMS} stopped the pass short. */
  readonly truncated: boolean;
};
