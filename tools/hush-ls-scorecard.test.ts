import { describe, expect, test } from "bun:test";

import {
  estimateTokens,
  formatHushLsScorecard,
  HUSH_LS_CORPUS_VERSION,
  passesHushLsScorecard,
  scoreHushLs,
} from "./hush-ls-scorecard.ts";

describe("Hush ls scorecard", () => {
  test("uses one UTF-8 byte estimator for every lane", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("λ")).toBe(1);
  });

  test("allows a tie but refuses more tokens or information loss", () => {
    const pass = scoreHushLs({
      id: "pass",
      argv: ["-la"],
      raw: "r".repeat(120),
      rtk: "b".repeat(80),
      hush: "h".repeat(40),
      fidelity: "deterministic-reduction",
      omissionRecords: 0,
      retainsEveryEntry: true,
      truncated: false,
      recoverable: true,
    });
    const tie = scoreHushLs({
      ...pass,
      id: "tie",
      raw: pass.raw.text,
      rtk: pass.rtk.text,
      hush: pass.rtk.text,
    });
    const overBudget = scoreHushLs({
      ...pass,
      id: "over-budget",
      raw: pass.raw.text,
      rtk: pass.rtk.text,
      hush: `${pass.rtk.text}x`,
    });
    expect(pass.withinRtkBudget).toBe(true);
    expect(tie.withinRtkBudget).toBe(true);
    expect(overBudget.withinRtkBudget).toBe(false);
    expect(passesHushLsScorecard([pass])).toBe(true);
    expect(passesHushLsScorecard([tie])).toBe(true);
    expect(passesHushLsScorecard([overBudget])).toBe(false);
    expect(passesHushLsScorecard([{ ...pass, retainsEveryEntry: false }])).toBe(false);
    expect(passesHushLsScorecard([{ ...pass, omissionRecords: 1 }])).toBe(false);
    expect(passesHushLsScorecard([{ ...pass, truncated: true }])).toBe(false);
    expect(passesHushLsScorecard([{ ...pass, fidelity: "raw-fallback" }])).toBe(false);
  });

  test("formats the pinned versions, estimator, and verdict", () => {
    const score = scoreHushLs({
      id: "recursive",
      argv: ["-R"],
      raw: "r".repeat(120),
      rtk: "b".repeat(80),
      hush: "h".repeat(40),
      fidelity: "deterministic-reduction",
      omissionRecords: 0,
      retainsEveryEntry: true,
      truncated: false,
      recoverable: true,
    });
    const formatted = formatHushLsScorecard({
      corpusVersion: HUSH_LS_CORPUS_VERSION,
      hushVersion: "hush.v2",
      rtkVersion: "rtk 0.45.0",
      estimator: "ceil(utf8-bytes/4)",
      scores: [score],
      passes: true,
    });
    expect(formatted).toContain("Hush hush.v2 vs rtk 0.45.0");
    expect(formatted).toContain("recursive");
    expect(formatted).toContain("TOTAL");
    expect(formatted).toContain("all");
    expect(formatted).toContain("scorecard: PASS");
  });
});
