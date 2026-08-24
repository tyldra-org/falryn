import { describe, expect, test } from "bun:test";

import {
  estimateTreeTokens,
  formatHushTreeScorecard,
  HUSH_TREE_CORPUS_VERSION,
  passesHushTreeScorecard,
  scoreHushTree,
} from "./hush-tree-scorecard.ts";

describe("Hush tree scorecard", () => {
  test("uses one UTF-8 byte estimator for every lane", () => {
    expect(estimateTreeTokens("abcd")).toBe(1);
    expect(estimateTreeTokens("abcde")).toBe(2);
    expect(estimateTreeTokens("λ")).toBe(1);
  });

  test("allows equality but refuses excess context or information loss", () => {
    const pass = scoreHushTree({
      id: "pass",
      argv: [],
      raw: "raw tree\nsummary\n",
      rtk: ["tree", "└── src", "    ├── a", "    └── b", ""].join("\n"),
      hush: ["tree/", "./:", "  src/", "src/:", "  a", "  b", ""].join("\n"),
      fidelity: "deterministic-reduction",
      omissionRecords: 0,
      truncated: false,
      recoverable: true,
    });
    const larger = scoreHushTree({
      ...pass,
      raw: pass.raw.text,
      rtk: pass.rtk.text,
      hush: `${pass.hush.text}extra\n`,
    });
    const different = scoreHushTree({
      ...pass,
      raw: pass.raw.text,
      rtk: pass.rtk.text,
      hush: "free\n",
    });

    expect(pass.withinRtkBudget).toBe(true);
    expect(pass.sameInformation).toBe(true);
    expect(passesHushTreeScorecard([pass])).toBe(true);
    expect(passesHushTreeScorecard([larger])).toBe(false);
    expect(passesHushTreeScorecard([different])).toBe(false);
    expect(passesHushTreeScorecard([{ ...pass, omissionRecords: 1 }])).toBe(false);
    expect(passesHushTreeScorecard([{ ...pass, truncated: true }])).toBe(false);
    expect(passesHushTreeScorecard([{ ...pass, fidelity: "raw-fallback" }])).toBe(false);
  });

  test("formats versions, complete content, totals, and verdict", () => {
    const score = scoreHushTree({
      id: "default",
      argv: [],
      raw: "raw tree\nsummary\n",
      rtk: "tree\n",
      hush: "tree\n",
      fidelity: "deterministic-reduction",
      omissionRecords: 0,
      truncated: false,
      recoverable: true,
    });
    const formatted = formatHushTreeScorecard({
      corpusVersion: HUSH_TREE_CORPUS_VERSION,
      hushVersion: "hush.v17",
      rtkVersion: "rtk 0.45.0",
      rtkCommit: "b34be37caf3796b69a50952a28e60e32b5daad43",
      estimator: "ceil(utf8-bytes/4)",
      scores: [score],
      passes: true,
    });

    expect(formatted).toContain("Hush hush.v17 vs rtk 0.45.0");
    expect(formatted).toContain("TOTAL");
    expect(formatted).toContain("all");
    expect(formatted).toContain("scorecard: PASS");
  });
});
