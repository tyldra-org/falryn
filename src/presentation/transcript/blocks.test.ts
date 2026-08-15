/**
 * The block model, and the one promise it exists to keep.
 *
 * That promise is negative: **nothing here infers success.** A transcript that
 * decided a block looked fine would be a transcript that could report a green
 * turn over a failed one, and it would do it most reliably in the case that
 * matters — a tool whose output reads like success and whose exit code does
 * not. So the tests below spend most of their effort proving that a status is
 * not an outcome, that three outcomes stay three facts, and that no function in
 * the module will answer "did it work" for a block that does not carry the
 * answer.
 */

import { describe, expect, test } from "bun:test";
import { admitTranscriptRecord } from "./admit.ts";
import type { TranscriptBlock } from "./blocks.ts";
import {
  BLOCK_SENSITIVITIES,
  blockKey,
  boundedTextsOf,
  describeBlock,
  expansionRoutesFor,
  outcomeOf,
  TRANSCRIPT_BLOCK_KINDS,
  UNKNOWN_TRANSCRIPT_BLOCK_KIND,
} from "./blocks.ts";
import {
  ALL_KINDS,
  coveredKinds,
  everyBlockKind,
  FIXTURE_AT,
  FIXTURE_INVOCATION,
} from "./fixtures.ts";

const CORPUS = everyBlockKind();

function ofKind(kind: TranscriptBlock["kind"]): TranscriptBlock {
  const block = CORPUS.find((candidate) => candidate.kind === kind);
  if (block === undefined) {
    throw new Error(`no fixture for ${kind}`);
  }
  return block;
}

describe("the declared kinds", () => {
  test("are every kind the fixtures cover, and no others", () => {
    // The control that makes "total over the declared kinds" mean a function
    // was called with each one, rather than that a switch looked exhaustive.
    expect([...coveredKinds()].sort()).toEqual([...ALL_KINDS].sort());
  });

  test("are all distinct", () => {
    expect(new Set(TRANSCRIPT_BLOCK_KINDS).size).toBe(TRANSCRIPT_BLOCK_KINDS.length);
    expect(TRANSCRIPT_BLOCK_KINDS).toHaveLength(16);
    expect(TRANSCRIPT_BLOCK_KINDS).not.toContain(UNKNOWN_TRANSCRIPT_BLOCK_KIND);
  });

  test("each have words of their own", () => {
    // `describeBlock` is exhaustive, so a kind added without a description does
    // not compile. This checks the descriptions are also distinguishable, which
    // the compiler cannot.
    const described = CORPUS.map(describeBlock);
    expect(described.every((words) => words.length > 0)).toBe(true);
    expect(new Set(described).size).toBe(described.length);
  });
});

describe("a status", () => {
  test("says whether the block is still changing and nothing else", () => {
    // The distinction this whole model rests on. A process that exited 1 is
    // final; final does not mean it worked.
    const exit = ofKind("process-exit");
    expect(exit.status).toBe("final");
    expect(outcomeOf(exit)).toEqual({ kind: "failed", effect: "partial" });
  });

  test("is never read as success by anything in the module", () => {
    // Every block whose kind carries no outcome reports `null`, including the
    // final ones. A default of "completed" here would be an interface inferring
    // success from the absence of evidence.
    for (const block of CORPUS) {
      const carries = ["model-outcome", "tool-result", "process-exit", "turn-outcome"].includes(
        block.kind,
      );
      if (!carries && block.kind !== "diagnostic") {
        expect({ kind: block.kind, outcome: outcomeOf(block) }).toEqual({
          kind: block.kind,
          outcome: null,
        });
      }
    }
  });
});

describe("outcomes", () => {
  test("stay three separate facts", () => {
    // The scenario the canonical contract names: a tool succeeded, the process
    // it ran failed, and the turn was cancelled. Three blocks, three answers,
    // and nothing anywhere that reduces them to a fourth.
    expect(outcomeOf(ofKind("tool-result"))).toEqual({ kind: "completed" });
    expect(outcomeOf(ofKind("process-exit"))).toEqual({ kind: "failed", effect: "partial" });
    expect(outcomeOf(ofKind("turn-outcome"))).toEqual({ kind: "cancelled", effect: "partial" });
  });

  test("survive attractive text above them", () => {
    // A summary that reads like success beside an outcome that is not. Only one
    // of the two is a fact, and `outcomeOf` is the only thing entitled to say
    // which.
    const exit = ofKind("process-exit");
    expect(exit.summary.text).toContain("failed");
    const dressed: TranscriptBlock = { ...exit, summary: { ...exit.summary, text: "All good!" } };
    expect(outcomeOf(dressed)).toEqual({ kind: "failed", effect: "partial" });
  });

  test("are optional on a diagnostic, which may describe unfinished work", () => {
    const diagnostic = ofKind("diagnostic");
    expect(diagnostic.kind === "diagnostic" && diagnostic.outcome !== null).toBe(true);
    expect(
      outcomeOf({ ...diagnostic, kind: "diagnostic", outcome: null, note: diagnostic.summary }),
    ).toBe(null);
  });
});

describe("identity", () => {
  test("is the anchor, so two revisions of one thing share a key", () => {
    const request = ofKind("tool-request");
    const result = ofKind("tool-result");
    expect(blockKey({ of: "invocation", invocationId: FIXTURE_INVOCATION })).toBe(
      blockKey(result.anchor),
    );
    // The fixtures deliberately anchor these two differently, so this asserts
    // the mechanism rather than an accident of the corpus.
    expect(blockKey(request.anchor)).not.toBe(blockKey(result.anchor));
  });

  test("gives every anchor variant a distinct key", () => {
    const keys = CORPUS.map((block) => blockKey(block.anchor));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("content", () => {
  test("always includes the summary, whatever the kind", () => {
    // `boundedTextsOf` is what the disclosure checks walk. A kind that escaped
    // it would be a kind whose content nothing bounded.
    for (const block of CORPUS) {
      expect({
        kind: block.kind,
        includesSummary: boundedTextsOf(block).includes(block.summary),
      }).toEqual({ kind: block.kind, includesSummary: true });
    }
  });

  test("is bounded on every kind that carries any", () => {
    for (const block of CORPUS) {
      expect({ kind: block.kind, empty: boundedTextsOf(block).length === 0 }).toEqual({
        kind: block.kind,
        empty: false,
      });
    }
  });
});

describe("expansion routes", () => {
  test("are derived from what is actually missing", () => {
    // Derived rather than stored, so a block whose content stopped being
    // truncated cannot keep advertising a route to the rest of something that
    // is entirely present.
    expect(expansionRoutesFor(ofKind("tool-result"))).toContain("transcript.expand");
    expect(expansionRoutesFor(ofKind("user-input"))).toEqual([]);
  });

  test("offer diagnostics for an outcome that was not a success", () => {
    expect(expansionRoutesFor(ofKind("process-exit"))).toContain("transcript.show-diagnostics");
    expect(expansionRoutesFor(ofKind("turn-outcome"))).toContain("transcript.show-diagnostics");
    // A completed outcome gets no diagnostics route: there is nothing to show.
    expect(expansionRoutesFor(ofKind("model-outcome"))).not.toContain(
      "transcript.show-diagnostics",
    );
  });

  test("offer the artifact when the block has one", () => {
    expect(expansionRoutesFor(ofKind("artifact"))).toContain("transcript.open-artifact");
  });

  test("are never duplicated", () => {
    for (const block of CORPUS) {
      const routes = expansionRoutesFor(block);
      expect({ kind: block.kind, unique: new Set(routes).size === routes.length }).toEqual({
        kind: block.kind,
        unique: true,
      });
    }
  });
});

describe("sensitivity", () => {
  test("declares no class the corpus does not construct", () => {
    // The same rule the expansion-route control states, in the other dimension:
    // a class that is exported, typed, and never constructed is not a contract,
    // it is a comment that compiles. It matters concretely for the transcript
    // surface — a rendering tested only against `ordinary` blocks would ship its
    // sensitivity handling unexercised.
    const constructed = new Set(CORPUS.map((block) => block.sensitivity));
    expect([...constructed].sort()).toEqual([...BLOCK_SENSITIVITIES].sort());
  });

  test("never projects the content of a secret block", () => {
    // A secret is not a stronger `sensitive`. Sensitive content may be revealed
    // by an explicit expansion; secret content has no expansion at all, so it is
    // never present in the projection to begin with.
    for (const block of CORPUS) {
      if (block.sensitivity !== "secret") {
        continue;
      }
      for (const bounded of boundedTextsOf(block)) {
        if (bounded === block.summary) {
          // The summary still says what is happening. A secret block is
          // withheld, not invisible.
          continue;
        }
        expect({ kind: block.kind, disclosure: bounded.disclosure.kind }).not.toEqual({
          kind: block.kind,
          disclosure: "complete",
        });
        expect({ kind: block.kind, text: bounded.text }).toEqual({ kind: block.kind, text: "" });
      }
    }
  });

  test("offers no route out of a secret block", () => {
    for (const block of CORPUS) {
      if (block.sensitivity === "secret") {
        expect({ kind: block.kind, routes: expansionRoutesFor(block) }).toEqual({
          kind: block.kind,
          routes: [],
        });
      }
    }
  });

  test("lets a sensitive block keep a route, because expansion may reveal it", () => {
    // The difference from a secret, asserted rather than described.
    const reasoning = ofKind("model-reasoning");
    expect(reasoning.sensitivity).toBe("sensitive");
    expect(expansionRoutesFor(reasoning)).toContain("transcript.expand");
  });
});

describe("the fixture corpus", () => {
  test("carries no content that a redaction would exist to hide", () => {
    // A fixture is checked in. One that demonstrated secret handling by holding
    // a credential would be the leak it was written to prevent — so the
    // sensitive case carries a redaction, which is what a real one carries too.
    const reasoning = ofKind("model-reasoning");
    expect(reasoning.kind === "model-reasoning" && reasoning.text.disclosure.kind).toBe("redacted");
    for (const block of CORPUS) {
      for (const bounded of boundedTextsOf(block)) {
        expect({
          kind: block.kind,
          leaks: /secret|password|api[-_]?key|token/i.test(bounded.text),
        }).toEqual({ kind: block.kind, leaks: false });
      }
    }
  });
});

describe("an unknown fallback", () => {
  test("never infers an outcome and never uses a known-kind description", () => {
    const result = admitTranscriptRecord({
      kind: "future-widget",
      order: 3,
      occurredAt: FIXTURE_AT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(outcomeOf(result.value)).toBe(null);
    expect(describeBlock(result.value)).toBe("Unrecognized block");
    expect(boundedTextsOf(result.value)).toContain(result.value.summary);
    expect(expansionRoutesFor(result.value)).toEqual([]);
  });
});
