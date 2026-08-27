/**
 * Fixture replay, and the two-way guard around the generation.
 *
 * The snapshot below is the reducer's output for a fixed run of events, written
 * out rather than computed. That is the point: a computed expectation passes
 * whatever the reducer does, and the whole reason this file exists is that #33
 * will change the reducer and someone has to notice.
 *
 * The guard has two directions, and both matter:
 *
 * - Change the reducer's structural output without raising the generation, and
 *   the snapshot fails.
 * - Raise the generation without updating the snapshot, and the generation
 *   assertion fails.
 *
 * So the pair can only be changed together, in one commit, deliberately — which
 * is exactly the review moment that a silent reducer change would otherwise
 * skip.
 *
 * "Structural" is the honest word and `./generation.ts` draws the same boundary:
 * which blocks exist, their anchors, kinds, statuses, and outcomes. Summary
 * wording is not pinned, because a snapshot that failed on a typo fix would
 * teach everyone to update it without reading it, and a guard nobody reads is
 * not a guard. That is a deliberate limit rather than an oversight, and it is
 * stated in both places so nobody has to infer it from what the snapshot
 * happens to contain. A cursor recorded under an older reducer describes blocks this build
 * would not produce, and resuming from it would splice two reducers' output
 * into one transcript with an invisible seam.
 */

import { describe, expect, test } from "bun:test";
import { everyEventKind, FIXTURE_STREAM } from "../../domain/fixtures.ts";
import type { StreamId } from "../../domain/index.ts";
import { initialCursor, resumable, TRANSCRIPT_PROJECTION_GENERATION } from "./generation.ts";
import { reduceTranscript } from "./reducer.ts";

/**
 * What generation 1 produces for `everyEventKind()`.
 *
 * Reduced to the facts a change would alter: which blocks exist, in what order,
 * what each is anchored to, whether it settled, and what outcome it reports.
 * Deliberately not a full structural snapshot — a snapshot that included every
 * summary string would fail on a typo fix and teach everyone to update it
 * without reading it.
 */
const GENERATION_2 = [
  { kind: "notice", key: "session:session-fixture", status: "final", outcome: null },
  { kind: "turn-outcome", key: "turn:turn-fixture", status: "final", outcome: "completed" },
  {
    kind: "model-outcome",
    key: "model-attempt:attempt-fixture",
    status: "final",
    outcome: "failed",
  },
  {
    kind: "tool-result",
    key: "invocation:invocation-fixture",
    status: "final",
    outcome: "uncertain",
  },
  { kind: "notice", key: "configuration:1", status: "final", outcome: null },
  {
    kind: "notice",
    key: "declared:execution-profile:selection-9",
    status: "final",
    outcome: null,
  },
] as const;

function snapshot(): readonly unknown[] {
  return reduceTranscript(everyEventKind()).blocks.map((block) => ({
    kind: block.kind,
    key:
      block.anchor.of === "session"
        ? `session:${block.anchor.sessionId}`
        : block.anchor.of === "turn"
          ? `turn:${block.anchor.turnId}`
          : block.anchor.of === "model-attempt"
            ? `model-attempt:${block.anchor.modelAttemptId}`
            : block.anchor.of === "invocation"
              ? `invocation:${block.anchor.invocationId}`
              : block.anchor.of === "configuration"
                ? `configuration:${block.anchor.generation}`
                : `declared:${block.anchor.key}`,
    status: block.status,
    outcome:
      "outcome" in block && block.outcome !== null && block.outcome !== undefined
        ? block.outcome.kind
        : null,
  }));
}

describe("replaying the fixture run", () => {
  test("produces what this generation recorded", () => {
    expect(snapshot()).toEqual([...GENERATION_2]);
  });

  test("is the snapshot for the generation the build declares", () => {
    // The other direction of the guard. Raising the generation without
    // revisiting the recorded output leaves a snapshot describing a reducer
    // that no longer exists.
    expect(TRANSCRIPT_PROJECTION_GENERATION).toBe(2);
  });

  test("replays identically twice", () => {
    expect(snapshot()).toEqual(snapshot());
  });

  test("stamps the projection with the generation that built it", () => {
    expect(reduceTranscript(everyEventKind()).generation).toBe(TRANSCRIPT_PROJECTION_GENERATION);
  });
});

describe("resuming from a cursor", () => {
  test("is allowed when the generation matches", () => {
    expect(resumable(initialCursor(FIXTURE_STREAM))).toBe(true);
  });

  test("is refused for an older reducer", () => {
    // The seam this prevents is invisible: half a transcript from one reducer
    // and half from another, with nothing in the result saying so.
    expect(resumable({ ...initialCursor(FIXTURE_STREAM), generation: 0 })).toBe(false);
  });

  test("is refused for a newer reducer too", () => {
    // A downgrade is as unusable as an upgrade. Guessing which of the two is
    // compatible is how a rollback produces a transcript that never existed.
    expect(
      resumable({
        ...initialCursor(FIXTURE_STREAM),
        generation: TRANSCRIPT_PROJECTION_GENERATION + 1,
      }),
    ).toBe(false);
  });

  test("starts a stream at nothing applied", () => {
    const cursor = initialCursor("session:new" as StreamId);
    expect(cursor.lastAppliedSequence).toBe(null);
    expect(cursor.generation).toBe(TRANSCRIPT_PROJECTION_GENERATION);
  });
});
