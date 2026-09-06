/**
 * Occurrence time for semantic events.
 *
 * Timestamps are recorded in one canonical form — UTC, millisecond precision —
 * so encoded events compare byte-for-byte across producers. They describe when
 * an event was observed; they never replace sequence as the ordering
 * authority, because two producers can disagree about the clock.
 */

import { err, ok, type Result } from "./result.ts";

declare const brand: unique symbol;

export type Timestamp = string & { readonly [brand]: "Timestamp" };

export type TimestampError = {
  readonly kind: "timestamp";
  readonly code: "timestamp-not-a-string" | "timestamp-not-canonical-utc";
};

/** `YYYY-MM-DDTHH:MM:SS.sssZ` — the exact form `Date#toISOString` produces. */
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseTimestamp(value: unknown): Result<Timestamp, TimestampError> {
  if (typeof value !== "string") {
    return err({ kind: "timestamp", code: "timestamp-not-a-string" });
  }
  if (!CANONICAL_UTC.test(value)) {
    return err({ kind: "timestamp", code: "timestamp-not-canonical-utc" });
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    return err({ kind: "timestamp", code: "timestamp-not-canonical-utc" });
  }
  return ok(value as Timestamp);
}

/** Converts trusted epoch milliseconds. Throws when the input is not a finite instant. */
export function timestampFromEpochMilliseconds(epochMilliseconds: number): Timestamp {
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new Error("invalid timestamp: epoch milliseconds must be a safe integer");
  }
  return new Date(epochMilliseconds).toISOString() as Timestamp;
}

export function timestampToEpochMilliseconds(timestamp: Timestamp): number {
  return Date.parse(timestamp);
}
