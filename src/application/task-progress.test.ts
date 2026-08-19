/**
 * Application-boundary secret refusal for progress projection.
 */

import { describe, expect, test } from "bun:test";
import { projectOutcomeProgress } from "./task-progress.ts";

describe("projectOutcomeProgress", () => {
  test("refuses a secret-shaped observation note without echoing it", () => {
    const result = projectOutcomeProgress({
      outcomeId: "outcome-1",
      tasks: ["t1"],
      observations: [{ taskId: "t1", status: "failed", note: "token sk-live-SECRET leaked" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("secret");
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });

  test("projects next actions for ordinary observations", () => {
    const result = projectOutcomeProgress({
      outcomeId: "outcome-1",
      tasks: ["t1", "t2"],
      dependencies: [{ predecessor: "t1", successor: "t2" }],
      observations: [{ taskId: "t1", status: "completed" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.overall).toBe("partial");
      expect(result.value.nextActions).toHaveLength(1);
    }
  });
});
