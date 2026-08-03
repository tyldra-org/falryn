/**
 * Events in, transcript out — and an honest count of what this build can show.
 *
 * The test that earns its place here is the last one in "what this build can
 * produce". Five of sixteen kinds have a producer, and asserting the number
 * rather than describing it means the day something starts producing a sixth,
 * this file says so. A transcript area that quietly grew a producer and left
 * `CURRENT-STATE.md` claiming otherwise is exactly the drift these controls
 * exist to prevent.
 *
 * The tool pair is the other thing worth watching. It is the only place in this
 * build where two real events revise one block, so it is the only place the
 * streaming contract is exercised by something other than a fixture.
 */

import { describe, expect, test } from "bun:test";
import {
  capabilityInvocationCompleted,
  capabilityInvocationStarted,
  configurationGenerationChanged,
  everyEventKind,
  FIXTURE_STREAM,
  modelAttemptCompleted,
  modelAttemptStarted,
  sessionStarted,
  turnCompleted,
  turnStarted,
} from "../../domain/fixtures.ts";
import { sequence } from "../../domain/index.ts";
import { outcomeOf } from "./blocks.ts";
import { TRANSCRIPT_PROJECTION_GENERATION } from "./generation.ts";
import { blockFor, EMPTY_PROJECTION, reduceTranscript } from "./reducer.ts";

describe("what this build can produce", () => {
  test("handles every event kind the runtime declares", () => {
    // Totality, called rather than asserted. `blockFor` is exhaustive at the
    // type level; this proves the exhaustive switch survives contact with real
    // event values.
    for (const event of everyEventKind()) {
      expect(() => blockFor(event)).not.toThrow();
    }
  });

  test("produces exactly five block kinds, and names them", () => {
    // The honest count. Eleven kinds are declared and unreachable because no
    // agent loop, provider, tool runner, or process boundary exists yet.
    const kinds = everyEventKind()
      .map(blockFor)
      .filter((block) => block !== null)
      .map((block) => block.kind);
    expect([...new Set(kinds)].sort()).toEqual([
      "model-outcome",
      "notice",
      "tool-request",
      "tool-result",
      "turn-outcome",
    ]);
  });

  test("draws nothing for the two events that only open a scope", () => {
    // A block for these would read "a turn began" directly above the blocks
    // showing what the turn did — a row whose entire content is that there are
    // rows below it.
    expect(blockFor(turnStarted(2))).toBe(null);
    expect(blockFor(modelAttemptStarted(4))).toBe(null);
  });

  test("marks every produced block ordinary, because no payload reaches it", () => {
    // Asserted rather than described. The runtime's events carry no payload, so
    // nothing here is sensitive or secret — and the first event that does carry
    // content has to revisit this instead of inheriting `ordinary` by default.
    for (const event of everyEventKind()) {
      const block = blockFor(event);
      if (block !== null) {
        expect({ kind: block.kind, sensitivity: block.sensitivity }).toEqual({
          kind: block.kind,
          sensitivity: "ordinary",
        });
      }
    }
  });

  test("stamps every block with the generation that produced it", () => {
    for (const event of everyEventKind()) {
      const block = blockFor(event);
      if (block !== null) {
        expect(block.renderGeneration).toBe(TRANSCRIPT_PROJECTION_GENERATION);
      }
    }
  });
});

describe("a tool call", () => {
  const events = [capabilityInvocationStarted(6), capabilityInvocationCompleted(7)];

  test("is one block that settles, not two rows", () => {
    // The streaming contract, exercised by real events rather than fixtures.
    const projection = reduceTranscript(events);
    expect(projection.blocks).toHaveLength(1);
    expect(projection.blocks[0]?.kind).toBe("tool-result");
    expect(projection.blocks[0]?.status).toBe("final");
  });

  test("keeps the position it started at", () => {
    const projection = reduceTranscript([sessionStarted(1), ...events]);
    expect(projection.blocks.map((block) => block.kind)).toEqual(["notice", "tool-result"]);
    expect(projection.blocks[1]?.order).toBe(1);
  });

  test("reports its outcome separately from anything it printed", () => {
    // The fixture's invocation ends uncertain, which is the useful case: the
    // block settled, and settling says nothing about whether it worked.
    const projection = reduceTranscript(events);
    expect(projection.blocks[0]?.status).toBe("final");
    expect(outcomeOf(projection.blocks[0] as never)).toEqual({
      kind: "uncertain",
      effect: "uncertain",
    });
  });

  test("says its input was never collected rather than showing none", () => {
    // Omitted, not empty. An empty string here renders as a tool called with no
    // arguments, which is a different and wrong statement.
    const request = blockFor(capabilityInvocationStarted(6));
    expect(request?.kind).toBe("tool-request");
    if (request?.kind === "tool-request") {
      expect(request.input.disclosure.kind).toBe("omitted");
    }
  });
});

describe("the three outcome facts", () => {
  test("arrive as three blocks that do not merge", () => {
    // A tool that succeeded, a model attempt that failed, and a turn that was
    // cancelled — all in one run. Three answers that stay three answers.
    const projection = reduceTranscript([
      capabilityInvocationCompleted(6, { kind: "completed" }),
      modelAttemptCompleted(7, { kind: "failed", effect: "none" }),
      turnCompleted(8, { kind: "cancelled", effect: "partial" }),
    ]);
    expect(projection.blocks.map((block) => block.kind)).toEqual([
      "tool-result",
      "model-outcome",
      "turn-outcome",
    ]);
    expect(projection.blocks.map(outcomeOf)).toEqual([
      { kind: "completed" },
      { kind: "failed", effect: "none" },
      { kind: "cancelled", effect: "partial" },
    ]);
  });
});

describe("cursors", () => {
  test("advance for events that produce no block", () => {
    // A cursor records what was read, not what was displayed. Advancing only on
    // rendered blocks would resume from before an event already applied.
    const projection = reduceTranscript([sessionStarted(1), turnStarted(2)]);
    expect(projection.blocks).toHaveLength(1);
    expect(projection.cursors).toEqual([
      {
        streamId: FIXTURE_STREAM,
        lastAppliedSequence: sequence.from(2),
        generation: TRANSCRIPT_PROJECTION_GENERATION,
      },
    ]);
  });

  test("carry the generation that folded them", () => {
    const projection = reduceTranscript([sessionStarted(1)]);
    expect(projection.cursors[0]?.generation).toBe(TRANSCRIPT_PROJECTION_GENERATION);
  });

  test("hold the highest sequence seen, not the last one delivered", () => {
    // An out-of-order tail must not rewind the cursor and cause the same events
    // to be folded twice on resume.
    const projection = reduceTranscript([turnCompleted(9), sessionStarted(2)]);
    expect(projection.cursors[0]?.lastAppliedSequence).toBe(sequence.from(9));
  });
});

describe("anomalies", () => {
  test("are surfaced on the projection rather than hidden", () => {
    // A transcript with a hole in it and a note about the hole is more useful
    // than a seamless one.
    const projection = reduceTranscript([sessionStarted(1), turnCompleted(6)]);
    expect(projection.anomalies).toHaveLength(1);
    expect(projection.anomalies[0]?.kind).toBe("gap");
    // And the blocks are still built. Detection reports; it does not discard.
    expect(projection.blocks).toHaveLength(2);
  });
});

describe("an empty run", () => {
  test("produces an empty projection rather than an error", () => {
    expect(reduceTranscript([])).toEqual(EMPTY_PROJECTION);
  });
});

describe("a configuration change", () => {
  test("becomes a notice naming the generation and when it applies", () => {
    const block = blockFor(configurationGenerationChanged(8));
    expect(block?.kind).toBe("notice");
    if (block?.kind === "notice") {
      expect(block.note.text).toContain("Generation");
    }
  });
});

describe("purity", () => {
  test("gives the same answer twice", () => {
    // The property that makes rebuilding a transcript produce the same
    // transcript rather than a second, differently-informed one.
    const events = everyEventKind();
    expect(reduceTranscript(events)).toEqual(reduceTranscript(events));
  });

  test("does not modify the run it was given", () => {
    // A reducer that consumed its input would make the second call over the
    // same events return something different from the first — which is the
    // failure the test above would not catch, because it re-reads the fixture.
    const events = [...everyEventKind()];
    const before = [...events];
    reduceTranscript(events);
    expect(events).toEqual(before);
  });
});
