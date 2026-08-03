/**
 * Coalescing changes how often a view repaints. It does not change what happened.
 *
 * That sentence is the contract, and these tests are the two halves of it. The
 * first half is order: a block keeps the position it was first seen at, so a
 * long-running tool call does not walk down the transcript every time it
 * reports progress. The second half is terminal status: once a block has
 * settled, a late, replayed, or duplicated revision cannot reopen it — which is
 * the failure that would otherwise erase a finished tool call's outcome and
 * leave it looking like it was still running.
 *
 * The frame-independence test is the one that matters most and looks least
 * interesting. A producer decides when to flush; a consumer must not be able to
 * tell. If folding in two frames differed from folding in ten, the transcript a
 * user saw would depend on network timing.
 */

import { describe, expect, test } from "bun:test";
import type { TranscriptBlock } from "./blocks.ts";
import { applyRevision, coalesce, EMPTY_TRANSCRIPT } from "./coalesce.ts";
import { complete } from "./disclosure.ts";
import { everyBlockKind, FIXTURE_AT } from "./fixtures.ts";
import { TRANSCRIPT_PROJECTION_GENERATION } from "./generation.ts";

function note(key: string, text: string, status: "in-progress" | "final" = "in-progress") {
  return {
    kind: "notice",
    anchor: { of: "declared", key },
    occurredAt: FIXTURE_AT,
    order: 0,
    source: "runtime",
    status,
    summary: complete(text),
    sensitivity: "ordinary",
    invocationId: null,
    artifactIds: [],
    renderGeneration: TRANSCRIPT_PROJECTION_GENERATION,
    note: complete(text),
  } satisfies TranscriptBlock;
}

describe("a block that has not been seen", () => {
  test("is appended in arrival order", () => {
    const state = coalesce([note("a", "first"), note("b", "second")]);
    expect(state.blocks.map((block) => block.summary.text)).toEqual(["first", "second"]);
    expect(state.blocks.map((block) => block.order)).toEqual([0, 1]);
  });
});

describe("a revision of a block that is still changing", () => {
  test("replaces it without moving it", () => {
    // The failure this prevents: a tool call reporting progress walks to the
    // bottom of the transcript, and a user reading it loses their place in the
    // only way that matters.
    const state = coalesce([note("a", "first"), note("b", "second"), note("a", "first, revised")]);
    expect(state.blocks.map((block) => block.summary.text)).toEqual(["first, revised", "second"]);
    expect(state.blocks.map((block) => block.order)).toEqual([0, 1]);
    expect(state.refusedRevisions).toBe(0);
  });

  test("does not grow the transcript", () => {
    // A hundred deltas of one sentence are one block, not a hundred rows.
    const deltas = Array.from({ length: 100 }, (_, index) => note("a", `token ${index}`));
    const state = coalesce(deltas);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.summary.text).toBe("token 99");
  });
});

describe("a revision of a block that has settled", () => {
  test("is refused and counted rather than applied", () => {
    // A duplicate or replayed delta arriving after a completion would otherwise
    // reopen a finished tool call and erase the outcome it already reported.
    const state = coalesce([
      note("a", "running"),
      note("a", "finished", "final"),
      note("a", "running again"),
    ]);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.summary.text).toBe("finished");
    expect(state.blocks[0]?.status).toBe("final");
    expect(state.refusedRevisions).toBe(1);
  });

  test("is reported rather than thrown", () => {
    // A duplicate delivery is a fact about the stream. A transcript that
    // refused to build because of one would be less useful than a transcript
    // that says it saw one.
    expect(() => coalesce([note("a", "done", "final"), note("a", "again")])).not.toThrow();
  });
});

describe("folding", () => {
  const revisions = [
    note("a", "a1"),
    note("b", "b1"),
    note("a", "a2"),
    note("c", "c1", "final"),
    note("b", "b2", "final"),
    note("c", "c2"),
    note("a", "a3", "final"),
  ];

  test("gives the same result whatever the frames", () => {
    // The property the whole streaming contract rests on: a producer decides
    // when to flush and a consumer must not be able to tell. Every split point
    // is checked rather than a sampled few — there are only as many as there
    // are revisions, and the one that breaks is never the one you would sample.
    const whole = coalesce(revisions);
    for (let split = 0; split <= revisions.length; split += 1) {
      const framed = revisions
        .slice(split)
        .reduce(applyRevision, coalesce(revisions.slice(0, split)));
      expect({ split, blocks: framed.blocks }).toEqual({ split, blocks: whole.blocks });
      expect({ split, refused: framed.refusedRevisions }).toEqual({
        split,
        refused: whole.refusedRevisions,
      });
    }
  });

  test("orders blocks by first appearance, not by settlement", () => {
    // `c` settles before `a` does, and `a` was seen first. Reading order is
    // when it started, because that is the order the user watched it happen in.
    expect(coalesce(revisions).blocks.map((block) => block.summary.text)).toEqual([
      "a3",
      "b2",
      "c1",
    ]);
  });

  test("preserves every terminal status once observed", () => {
    // `c` was final at revision four and revised at six. The later revision
    // does not survive, in any framing.
    const state = coalesce(revisions);
    expect(state.blocks.every((block) => block.status === "final")).toBe(true);
    expect(state.refusedRevisions).toBe(1);
  });

  test("leaves an empty run empty", () => {
    expect(coalesce([])).toEqual(EMPTY_TRANSCRIPT);
  });
});

describe("the corpus", () => {
  test("folds to one block per distinct anchor", () => {
    // Every fixture has its own anchor, so nothing merges. A change that made
    // two kinds share an anchor would show up here rather than as a block
    // mysteriously missing from a rendering test.
    const state = coalesce(everyBlockKind());
    expect(state.blocks).toHaveLength(everyBlockKind().length);
    expect(state.refusedRevisions).toBe(0);
  });
});
