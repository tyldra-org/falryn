/** Coverage scorecard contract for the pinned RTK command inventory. */

import { describe, expect, test } from "bun:test";

import {
  createHushCommandCoverageScorecard,
  formatHushCommandCoverageScorecard,
  HUSH_RTK_BASELINE,
} from "./hush-command-coverage.ts";

describe("Hush command coverage scorecard", () => {
  test("pins the released RTK source inventory", () => {
    expect(HUSH_RTK_BASELINE).toEqual({
      version: "rtk 0.45.0",
      commit: "b34be37caf3796b69a50952a28e60e32b5daad43",
      nativeRewriteRules: 86,
      builtInFilters: 63,
    });
  });

  test("requires every maintained example to resolve to its owning reducer", () => {
    const scorecard = createHushCommandCoverageScorecard();
    expect(scorecard.catalogEntries).toBeGreaterThan(0);
    expect(scorecard.commandExecutables).toBeGreaterThan(100);
    expect(scorecard.examples).toBeGreaterThan(150);
    expect(scorecard.projectionKinds).toBeGreaterThan(10);
    expect(scorecard.failures).toEqual([]);
    expect(scorecard.routingComplete).toBe(true);
    expect(scorecard.parityProvenProjections).toHaveLength(19);
    expect(scorecard.parityProvenReducers).toHaveLength(scorecard.catalogEntries);
    expect(scorecard.parityProvenReducers).toContain("files.ls");
    expect(scorecard.parityProvenReducers).toContain("files.tree");
    expect(scorecard.parityProvenReducers).toContain("data.command");
  });

  test("reports routing separately from token parity", () => {
    const formatted = formatHushCommandCoverageScorecard(createHushCommandCoverageScorecard());
    expect(formatted).toContain("routing: PASS");
    expect(formatted).toContain("token/context parity proven: 80 reducers across 19 projections");
  });
});
