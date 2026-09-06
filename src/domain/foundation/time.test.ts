import { describe, expect, test } from "bun:test";

import {
  parseTimestamp,
  timestampFromEpochMilliseconds,
  timestampToEpochMilliseconds,
} from "./time.ts";

describe("timestamps", () => {
  test("accepts canonical UTC with millisecond precision", () => {
    const parsed = parseTimestamp("2026-07-31T12:00:00.000Z");
    expect(parsed.ok).toBe(true);
  });

  test.each([
    ["an offset instead of Z", "2026-07-31T12:00:00.000+01:00"],
    ["missing milliseconds", "2026-07-31T12:00:00Z"],
    ["a space separator", "2026-07-31 12:00:00.000Z"],
    ["a date only", "2026-07-31"],
  ])("rejects %s", (_label, value) => {
    const parsed = parseTimestamp(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("timestamp-not-canonical-utc");
    }
  });

  test("rejects a well-formed but impossible instant", () => {
    expect(parseTimestamp("2026-02-31T12:00:00.000Z").ok).toBe(false);
  });

  test("rejects a non-string", () => {
    const parsed = parseTimestamp(1_800_000_000_000);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("timestamp-not-a-string");
    }
  });

  test("round-trips epoch milliseconds", () => {
    const epoch = Date.UTC(2026, 6, 31, 12, 0, 0);
    const timestamp = timestampFromEpochMilliseconds(epoch);
    expect(String(timestamp)).toBe("2026-07-31T12:00:00.000Z");
    expect(timestampToEpochMilliseconds(timestamp)).toBe(epoch);
  });

  test("rejects a non-integer instant", () => {
    expect(() => timestampFromEpochMilliseconds(Number.NaN)).toThrow("invalid timestamp");
  });
});
