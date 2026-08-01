/**
 * The projection reducer and its cursor.
 *
 * The reducer is the part of a projection that has to be provably pure: a
 * rebuild is only trustworthy if the same events produce the same result on a
 * machine that has no network, no provider credentials, and no workspace. These
 * checks pin that, and pin what a stored cursor is allowed to be.
 */

import { describe, expect, test } from "bun:test";

import {
  capabilityInvocationCompleted,
  everyEventKind,
  FIXTURE_OCCURRED_AT,
  FIXTURE_STREAM,
  modelAttemptCompleted,
  sessionStarted,
  turnCompleted,
  turnStarted,
} from "./fixtures.ts";
import { sequence } from "./identity.ts";
import {
  PROJECTION_NAMES,
  parseProjectionCursor,
  reduceCompletions,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
} from "./projection.ts";

describe("the terminal-outcome reducer", () => {
  test("derives one completion per completed record and nothing else", () => {
    expect(reduceCompletions(everyEventKind()).map((entry) => entry.entity)).toEqual([
      "turn",
      "model-attempt",
      "invocation",
    ]);
  });

  test("ignores events that say nothing about a terminal state", () => {
    expect(reduceCompletions([sessionStarted(1), turnStarted(2)])).toEqual([]);
  });

  test("carries the outcome and the time the event says it happened", () => {
    const completed = reduceCompletions([turnCompleted(3, { kind: "failed", effect: "partial" })]);

    expect(completed).toEqual([
      {
        entity: "turn",
        turnId: turnCompleted(3).correlation.turnId,
        completedAt: FIXTURE_OCCURRED_AT,
        outcome: { kind: "failed", effect: "partial" },
      },
    ]);
  });

  test("is deterministic: the same events reduce identically every time", () => {
    const events = everyEventKind();

    expect(reduceCompletions(events)).toEqual(reduceCompletions(events));
  });

  test("keeps event order, so a later fact supersedes an earlier one when applied", () => {
    const first = modelAttemptCompleted(5, { kind: "failed", effect: "none" });
    const second = { ...modelAttemptCompleted(6, { kind: "completed" }) };

    expect(reduceCompletions([first, second]).map((entry) => entry.outcome)).toEqual([
      { kind: "failed", effect: "none" },
      { kind: "completed" },
    ]);
  });

  test("reads an invocation's identity from the event rather than the correlation", () => {
    const [completion] = reduceCompletions([capabilityInvocationCompleted(7)]);

    expect(completion).toMatchObject({
      entity: "invocation",
      invocationId: capabilityInvocationCompleted(7).invocationId,
    });
  });
});

describe("a stored cursor", () => {
  const cursor = {
    projection: PROJECTION_NAMES[0],
    streamId: FIXTURE_STREAM,
    lastAppliedSequence: sequence.from(4),
    schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
    updatedAt: FIXTURE_OCCURRED_AT,
  };

  test("round-trips", () => {
    const parsed = parseProjectionCursor(cursor);

    expect(parsed.ok && parsed.value).toEqual(cursor);
  });

  test("accepts a cursor that has applied nothing yet", () => {
    expect(parseProjectionCursor({ ...cursor, lastAppliedSequence: null }).ok).toBe(true);
  });

  test("refuses a projection this build does not have", () => {
    // Resuming from a cursor whose reducer is unknown would describe state this
    // build cannot reason about.
    expect(parseProjectionCursor({ ...cursor, projection: "transcript" }).ok).toBe(false);
  });

  test("refuses a sequence below the first one", () => {
    expect(parseProjectionCursor({ ...cursor, lastAppliedSequence: 0 }).ok).toBe(false);
  });
});
