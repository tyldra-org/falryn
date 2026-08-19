/**
 * Application-boundary secret refusal for validation advice.
 */

import { describe, expect, test } from "bun:test";
import { recommendOutcomeValidation } from "./task-validation.ts";

describe("recommendOutcomeValidation", () => {
  test("refuses a secret-shaped criterion without echoing it", () => {
    const result = recommendOutcomeValidation({
      outcomeId: "outcome-1",
      tasks: [{ taskId: "t1", criteria: ["token sk-live-SECRET must remain"] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("secret");
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });

  test("recommends focused validation for ordinary criteria", () => {
    const result = recommendOutcomeValidation({
      outcomeId: "outcome-1",
      tasks: [{ taskId: "t1", criteria: ["Restore succeeds from the package"] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recommendations).toHaveLength(2);
    }
  });
});
