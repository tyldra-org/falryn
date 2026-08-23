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

  test("requires Hush to be strictly smaller and recoverable", () => {
    const pass = scoreHushLs({
      id: "pass",
      argv: ["-la"],
      raw: "r".repeat(120),
      rtk: "b".repeat(80),
      hush: "h".repeat(40),
      fidelity: "deterministic-reduction",
      omissionRecords: 1,
      recoverable: true,
    });
    const tie = scoreHushLs({
      ...pass,
      id: "tie",
      raw: pass.raw.text,
      rtk: pass.rtk.text,
      hush: pass.rtk.text,
    });
    expect(pass.beatsRtk).toBe(true);
    expect(tie.beatsRtk).toBe(false);
    expect(passesHushLsScorecard([pass])).toBe(true);
    expect(passesHushLsScorecard([tie])).toBe(false);
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
      omissionRecords: 1,
      recoverable: true,
    });
    const formatted = formatHushLsScorecard({
      corpusVersion: HUSH_LS_CORPUS_VERSION,
      hushVersion: "hush.v1",
      rtkVersion: "rtk 0.45.0",
      estimator: "ceil(utf8-bytes/4)",
      scores: [score],
      passes: true,
    });
    expect(formatted).toContain("Hush hush.v1 vs rtk 0.45.0");
    expect(formatted).toContain("recursive");
    expect(formatted).toContain("scorecard: PASS");
  });
});
