/**
 * Scoped sequence rules for event streams.
 *
 * Sequence is monotonic within one declared stream and means nothing across
 * streams, so every decision is made against an explicit `streamId`. Two
 * streams interleaved in one process never observe each other's numbering.
 *
 * Idempotency is the other half of the rule: an append repeated after a retry
 * is a no-op, not a second event. Reusing an idempotency key for a different
 * event is a conflict rather than a silent overwrite, because that is a
 * producer defect and hiding it would duplicate or lose a fact.
 */

import type { RuntimeEvent } from "./event.ts";
import {
  type EventId,
  FIRST_SEQUENCE,
  type IdempotencyKey,
  nextSequence,
  type Sequence,
  type StreamId,
} from "./identity.ts";

/**
 * Events tracked per stream before the sequencer refuses further appends.
 *
 * The sequencer is an in-memory authority for one replay or one run. Durable
 * deduplication beyond this window belongs to the persistent event store.
 */
export const MAX_TRACKED_EVENTS_PER_STREAM = 100_000;

export type SequenceError =
  /** Sequence went backwards; the stream already holds a later event. */
  | {
      readonly code: "sequence-out-of-order";
      readonly streamId: StreamId;
      readonly expectedSequence: Sequence;
      readonly observedSequence: Sequence;
    }
  /** Sequence skipped ahead; at least one event is missing. */
  | {
      readonly code: "sequence-gap";
      readonly streamId: StreamId;
      readonly expectedSequence: Sequence;
      readonly observedSequence: Sequence;
    }
  /** The idempotency key was used before by a different event. */
  | {
      readonly code: "idempotency-conflict";
      readonly streamId: StreamId;
      readonly idempotencyKey: IdempotencyKey;
      readonly recordedEventId: EventId;
      readonly observedEventId: EventId;
    }
  /** The event identifier was used before under a different idempotency key. */
  | {
      readonly code: "event-id-conflict";
      readonly streamId: StreamId;
      readonly eventId: EventId;
    }
  /** The in-memory tracking window is full. */
  | {
      readonly code: "ledger-capacity-exceeded";
      readonly streamId: StreamId;
      readonly maximumTrackedEvents: number;
    };

export type AppendDecision =
  | { readonly kind: "appended"; readonly sequence: Sequence }
  /** The event was already appended. Nothing changed. */
  | { readonly kind: "duplicate"; readonly sequence: Sequence }
  | { readonly kind: "rejected"; readonly error: SequenceError };

type TrackedEvent = {
  readonly eventId: EventId;
  readonly sequence: Sequence;
};

type StreamState = {
  lastSequence: Sequence;
  readonly byIdempotencyKey: Map<IdempotencyKey, TrackedEvent>;
  readonly eventIds: Map<EventId, IdempotencyKey>;
};

export type StreamSequencer = {
  /** Decides whether an event may join its stream, and records the decision. */
  append(event: RuntimeEvent): AppendDecision;
  /** Last accepted sequence in a stream, or `null` when the stream is empty. */
  lastSequence(streamId: StreamId): Sequence | null;
  /** The sequence the next event in a stream must carry. */
  expectedSequence(streamId: StreamId): Sequence;
  /** Streams this sequencer has accepted at least one event for. */
  streams(): readonly StreamId[];
  trackedEventCount(streamId: StreamId): number;
};

export function createStreamSequencer(): StreamSequencer {
  const streams = new Map<StreamId, StreamState>();

  const stateOf = (streamId: StreamId): StreamState | undefined => streams.get(streamId);

  return {
    append(event: RuntimeEvent): AppendDecision {
      const state = stateOf(event.streamId);

      if (state === undefined) {
        if (event.sequence !== FIRST_SEQUENCE) {
          return rejectFirstSequence(event);
        }
        streams.set(event.streamId, {
          lastSequence: event.sequence,
          byIdempotencyKey: new Map([
            [event.idempotencyKey, { eventId: event.eventId, sequence: event.sequence }],
          ]),
          eventIds: new Map([[event.eventId, event.idempotencyKey]]),
        });
        return { kind: "appended", sequence: event.sequence };
      }

      const recorded = state.byIdempotencyKey.get(event.idempotencyKey);
      if (recorded !== undefined) {
        if (recorded.eventId !== event.eventId) {
          return {
            kind: "rejected",
            error: {
              code: "idempotency-conflict",
              streamId: event.streamId,
              idempotencyKey: event.idempotencyKey,
              recordedEventId: recorded.eventId,
              observedEventId: event.eventId,
            },
          };
        }
        return { kind: "duplicate", sequence: recorded.sequence };
      }

      if (state.eventIds.has(event.eventId)) {
        return {
          kind: "rejected",
          error: {
            code: "event-id-conflict",
            streamId: event.streamId,
            eventId: event.eventId,
          },
        };
      }

      if (state.eventIds.size >= MAX_TRACKED_EVENTS_PER_STREAM) {
        return {
          kind: "rejected",
          error: {
            code: "ledger-capacity-exceeded",
            streamId: event.streamId,
            maximumTrackedEvents: MAX_TRACKED_EVENTS_PER_STREAM,
          },
        };
      }

      const expected = nextSequence(state.lastSequence);
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

      state.lastSequence = event.sequence;
      state.byIdempotencyKey.set(event.idempotencyKey, {
        eventId: event.eventId,
        sequence: event.sequence,
      });
      state.eventIds.set(event.eventId, event.idempotencyKey);
      return { kind: "appended", sequence: event.sequence };
    },

    lastSequence(streamId: StreamId): Sequence | null {
      return stateOf(streamId)?.lastSequence ?? null;
    },

    expectedSequence(streamId: StreamId): Sequence {
      const state = stateOf(streamId);
      return state === undefined ? FIRST_SEQUENCE : nextSequence(state.lastSequence);
    },

    streams(): readonly StreamId[] {
      return [...streams.keys()];
    },

    trackedEventCount(streamId: StreamId): number {
      return stateOf(streamId)?.eventIds.size ?? 0;
    },
  };
}

function rejectFirstSequence(event: RuntimeEvent): AppendDecision {
  return {
    kind: "rejected",
    error:
      event.sequence < FIRST_SEQUENCE
        ? {
            code: "sequence-out-of-order",
            streamId: event.streamId,
            expectedSequence: FIRST_SEQUENCE,
            observedSequence: event.sequence,
          }
        : {
            code: "sequence-gap",
            streamId: event.streamId,
            expectedSequence: FIRST_SEQUENCE,
            observedSequence: event.sequence,
          },
  };
}

export type ReplayAnomaly = {
  /** Position in the replayed input, so the offending record can be located. */
  readonly index: number;
  readonly error: SequenceError;
};

export type ReplayReport = {
  readonly appended: number;
  readonly duplicates: number;
  readonly anomalies: readonly ReplayAnomaly[];
  readonly streams: readonly StreamId[];
};

/**
 * Replays a sequence of events and reports what the ordering rules observed.
 *
 * Replay is an observation, not a repair: a gap is reported rather than
 * closed, and a duplicate is counted rather than appended again.
 */
export function inspectReplay(events: readonly RuntimeEvent[]): ReplayReport {
  const sequencer = createStreamSequencer();
  const anomalies: ReplayAnomaly[] = [];
  let appended = 0;
  let duplicates = 0;

  events.forEach((event, index) => {
    const decision = sequencer.append(event);
    switch (decision.kind) {
      case "appended":
        appended += 1;
        break;
      case "duplicate":
        duplicates += 1;
        break;
      case "rejected":
        anomalies.push({ index, error: decision.error });
        break;
    }
  });

  return { appended, duplicates, anomalies, streams: sequencer.streams() };
}
