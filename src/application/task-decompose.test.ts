/**
 * Application-boundary secret refusal for task decomposition.
 */

import { describe, expect, test } from "bun:test";
import { decomposeOutcome } from "./task-decompose.ts";

describe("decomposeOutcome", () => {
  test("refuses a secret-shaped statement without echoing it", () => {
    const result = decomposeOutcome({
      outcomeId: "outcome-1",
      statement: "Use token sk-live-SECRET to ship the export.",
      goals: ["Write the export package"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("secret");
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });

  test("decomposes ordinary declared goals", () => {
    const result = decomposeOutcome({
      outcomeId: "outcome-1",
      statement: "Ship a bounded export.",
      goals: ["Write the export package"],
      nonGoals: ["Execute Git"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tasks).toHaveLength(1);
    }
  });
});
