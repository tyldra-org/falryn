/**
 * Local prompt-draft normalization (#279).
 */

import { describe, expect, test } from "bun:test";
import {
  describeEnhancement,
  explainNormalization,
  normalizePromptDraft,
} from "./prompt-enhancement.ts";

describe("normalizePromptDraft", () => {
  test("leaves a clean draft unchanged", () => {
    expect(normalizePromptDraft("ask for a summary")).toEqual({
      proposed: "ask for a summary",
      changes: [],
    });
  });

  test("trims edges, trailing spaces, extra blanks, and CR LF", () => {
    const raw = "  hello  \r\n\r\n\r\nworld  \t\n";
    const result = normalizePromptDraft(raw);
    expect(result.proposed).toBe("hello\n\nworld");
    expect(result.changes).toEqual([
      "folded line endings",
      "trimmed trailing spaces",
      "collapsed extra blank lines",
      "trimmed edges",
    ]);
  });

  test("collapses three or more newlines to one blank line", () => {
    expect(normalizePromptDraft("a\n\n\n\nb").proposed).toBe("a\n\nb");
  });
});

describe("explainNormalization", () => {
  test("joins mechanical steps in one sentence", () => {
    expect(explainNormalization([])).toBe("no mechanical changes");
    expect(explainNormalization(["trimmed edges"])).toBe("trimmed edges");
    expect(explainNormalization(["trimmed edges", "collapsed extra blank lines"])).toBe(
      "trimmed edges, and collapsed extra blank lines",
    );
  });
});

describe("describeEnhancement", () => {
  test("names each outcome without implying a submission", () => {
    expect(
      describeEnhancement({
        kind: "proposal",
        original: "  a  ",
        proposed: "a",
        explanation: "trimmed edges",
        revision: 1,
      }),
    ).toContain("Accept or reject");
    expect(describeEnhancement({ kind: "empty" })).toContain("empty");
    expect(
      describeEnhancement({
        kind: "unavailable",
        reason: "no provider is configured",
        owner: "#33",
      }),
    ).toContain("#33");
  });
});
