/**
 * The record contracts.
 *
 * These check the boundary a stored row crosses on its way back into domain
 * state: what a parser accepts, what it refuses, and what a rejection is
 * allowed to say. A record parsed from a hand-edited database is the same
 * problem as an event arriving from transport, so it is held to the same
 * standard — structure only, no rejected value, no unknown member widened onto
 * a known one.
 */

import { describe, expect, test } from "bun:test";

import { invocationRecord, modelAttemptRecord, sessionRecord, turnRecord } from "./fixtures.ts";
import { MAX_IDENTIFIER_LENGTH } from "./limits.ts";
import {
  MAX_INPUT_DIGEST_LENGTH,
  MAX_SESSION_TITLE_LENGTH,
  outcomeFromColumns,
  parseInvocationRecord,
  parseModelAttemptRecord,
  parseSessionRecord,
  parseTurnRecord,
  RECORD_ENTITIES,
} from "./records.ts";

describe("a stored outcome", () => {
  test("is absent when neither column holds one", () => {
    expect(outcomeFromColumns(null, null)).toBeNull();
  });

  test("drops the stored effect for completed, which the domain implies", () => {
    expect(outcomeFromColumns("completed", "completed")).toEqual({ kind: "completed" });
  });

  test("keeps the effect for every outcome that carries one", () => {
    expect(outcomeFromColumns("timed-out", "uncertain")).toEqual({
      kind: "timed-out",
      effect: "uncertain",
    });
  });
});

describe("a session row", () => {
  test("round-trips a record that a repository would have written", () => {
    const record = sessionRecord({ closedAt: null, outcome: null });
    const parsed = parseSessionRecord(record);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual(record);
  });

  test("accepts a closed session carrying its terminal outcome", () => {
    const record = sessionRecord({
      closedAt: sessionRecord().startedAt,
      outcome: { kind: "cancelled", effect: "partial" },
    });

    expect(parseSessionRecord(record).ok).toBe(true);
  });

  test("refuses an identity that is not one, naming the path and not the value", () => {
    const parsed = parseSessionRecord({ ...sessionRecord(), sessionId: "with a space" });

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toEqual([{ path: "sessionId", code: "custom" }]);
  });

  test("refuses an outcome kind this build does not have", () => {
    const parsed = parseSessionRecord({
      ...sessionRecord(),
      closedAt: sessionRecord().startedAt,
      outcome: { kind: "abandoned", effect: "none" },
    });

    expect(parsed.ok).toBe(false);
  });

  test("refuses a title longer than the declared bound", () => {
    const parsed = parseSessionRecord({
      ...sessionRecord(),
      title: "t".repeat(MAX_SESSION_TITLE_LENGTH + 1),
    });

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.map((issue) => issue.path)).toEqual(["title"]);
  });

  test("refuses an identifier longer than the declared bound", () => {
    const parsed = parseSessionRecord({
      ...sessionRecord(),
      workspaceId: "w".repeat(MAX_IDENTIFIER_LENGTH + 1),
    });

    expect(parsed.ok).toBe(false);
  });
});

describe("a turn row", () => {
  test("round-trips, including a fork's parent", () => {
    const record = turnRecord({ parentTurnId: turnRecord().turnId });

    expect(parseTurnRecord(record).ok).toBe(true);
  });

  test("refuses a completion time that is not a canonical timestamp", () => {
    const parsed = parseTurnRecord({ ...turnRecord(), completedAt: "yesterday" });

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.map((issue) => issue.path)).toEqual(["completedAt"]);
  });
});

describe("a model attempt row", () => {
  test("round-trips its provider and model identities", () => {
    const record = modelAttemptRecord();
    const parsed = parseModelAttemptRecord(record);

    expect(parsed.ok && parsed.value).toEqual(record);
  });

  test("refuses a provider that is not an identifier", () => {
    expect(parseModelAttemptRecord({ ...modelAttemptRecord(), providerId: "" }).ok).toBe(false);
  });
});

describe("an invocation row", () => {
  test("round-trips its capability, version, and input digest", () => {
    const record = invocationRecord();

    expect(parseInvocationRecord(record).ok).toBe(true);
  });

  test("refuses a digest that is not lowercase hexadecimal", () => {
    // A digest column that accepted prose would be a place for input to be
    // stored under a name that says it was not.
    const parsed = parseInvocationRecord({
      ...invocationRecord(),
      inputDigest: "read /etc/passwd",
    });

    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.map((issue) => issue.path)).toEqual(["inputDigest"]);
  });

  test("refuses a digest longer than the declared bound", () => {
    const parsed = parseInvocationRecord({
      ...invocationRecord(),
      inputDigest: "a".repeat(MAX_INPUT_DIGEST_LENGTH + 1),
    });

    expect(parsed.ok).toBe(false);
  });

  test("refuses a capability version below the first one", () => {
    expect(parseInvocationRecord({ ...invocationRecord(), capabilityVersion: 0 }).ok).toBe(false);
  });
});

describe("the record entities", () => {
  test("name every table this area owns records for", () => {
    expect([...RECORD_ENTITIES]).toEqual([
      "session",
      "turn",
      "model-attempt",
      "invocation",
      "projection-cursor",
    ]);
  });
});
