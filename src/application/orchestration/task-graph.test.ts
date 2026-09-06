/**
 * Application-boundary secret refusal for a static task graph.
 */

import { describe, expect, test } from "bun:test";
import { planOutcomeTaskGraph } from "./task-graph.ts";

describe("planOutcomeTaskGraph", () => {
  test("refuses a secret-shaped blocker without echoing it", () => {
    const result = planOutcomeTaskGraph({
      outcomeId: "outcome-1",
      tasks: ["t1"],
      blockers: [{ taskId: "t1", reason: "token sk-live-SECRET is missing" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("secret");
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });

  test("plans ordinary declared dependencies", () => {
    const result = planOutcomeTaskGraph({
      outcomeId: "outcome-1",
      tasks: ["t1", "t2"],
      dependencies: [{ predecessor: "t1", successor: "t2" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.nodes[1]?.readiness).toBe("waiting");
    }
  });
});
