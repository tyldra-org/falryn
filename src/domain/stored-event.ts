/**
 * Lossless mapping between the domain envelope and the persisted event shape.
 *
 * The persisted shape is fixed by the data layer: identity, ordering, kind,
 * version, time, and trace are columns, and everything else is payload. This
 * module maps onto that shape without changing it — the remaining envelope
 * identity travels inside the payload, and `fromStoredEvent` reconstitutes the
 * exact event that `toStoredEvent` was given.
 *
 * `traceId` is stored only as a column. It is removed from the payload copy of
 * the correlation so the two can never disagree.
 */

import { decodeRuntimeEvent } from "./codec.ts";
import type { CodecError } from "./codec-error.ts";
import type { RuntimeEvent } from "./event.ts";
import type { EventId, TraceId } from "./identity.ts";
import type { Result } from "./result.ts";
import { toWireEvent } from "./wire.ts";

export type StoredEvent = {
  readonly eventId: EventId;
  /** The stream the event is sequenced within. */
  readonly aggregateId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly traceId: TraceId;
  readonly payload: Record<string, unknown>;
};

/** Envelope fields that become columns rather than payload. */
const COLUMN_FIELDS = ["eventId", "streamId", "sequence", "kind", "schemaVersion", "occurredAt"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omit(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

export function toStoredEvent(event: RuntimeEvent): StoredEvent {
  const wire = toWireEvent(event);
  const correlation = isRecord(wire.correlation) ? wire.correlation : {};
  const payload = omit(wire, [...COLUMN_FIELDS, "correlation"]);
  payload.correlation = omit(correlation, ["traceId"]);

  return {
    eventId: event.eventId,
    aggregateId: event.streamId,
    sequence: event.sequence,
    kind: event.kind,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    traceId: event.correlation.traceId,
    payload,
  };
}

/**
 * Rebuilds an event from its persisted row.
 *
 * A row is untrusted input — it may have been written by a newer build, edited
 * by hand, or corrupted — so it runs through the same codec policy as an event
 * arriving from transport.
 */
export function fromStoredEvent(stored: StoredEvent): Result<RuntimeEvent, CodecError> {
  const storedCorrelation = isRecord(stored.payload.correlation) ? stored.payload.correlation : {};
  const wire: Record<string, unknown> = {
    ...omit(stored.payload, ["correlation"]),
    eventId: stored.eventId,
    streamId: stored.aggregateId,
    sequence: stored.sequence,
    kind: stored.kind,
    schemaVersion: stored.schemaVersion,
    occurredAt: stored.occurredAt,
    correlation: { ...storedCorrelation, traceId: stored.traceId },
  };
  return decodeRuntimeEvent(JSON.stringify(wire));
}
