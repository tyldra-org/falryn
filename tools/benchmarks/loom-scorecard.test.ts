/** Regression contract for the pinned Loom/Headroom evidence scorecard. */

import { describe, expect, test } from "bun:test";

import { createLoomScorecard, formatLoomScorecard } from "./loom-scorecard.ts";

describe("Loom scorecard", () => {
  test("keeps required facts and stays within the pinned Headroom budget", () => {
    const scorecard = createLoomScorecard();

    expect(scorecard.passes).toBe(true);
    expect(scorecard.sourceDigestMatches).toBe(true);
    expect(scorecard.scores).toHaveLength(2);
    expect(scorecard.scores.every((score) => score.requiredFactsPreserved)).toBe(true);
    expect(scorecard.scores.every((score) => score.exactRecoverable)).toBe(true);
    expect(scorecard.scores.every((score) => score.withinHeadroomBudget)).toBe(true);
    expect(scorecard.scores.find((score) => score.projection === "range")?.storageBytesRead).toBe(
      54,
    );
    expect(
      scorecard.scores.find((score) => score.projection === "head-tail")?.storageBytesRead,
    ).toBe(192);
    expect(formatLoomScorecard(scorecard)).toContain("scorecard: PASS");
  });
});
