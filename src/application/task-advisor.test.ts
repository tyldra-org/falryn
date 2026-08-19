/**
 * Application-boundary secret refusal for advisor modes.
 */

import { describe, expect, test } from "bun:test";
import { adviseOutcome } from "./task-advisor.ts";

describe("adviseOutcome", () => {
  test("refuses a secret-shaped question without echoing it", () => {
    const result = adviseOutcome({
      mode: "review",
      question: "token sk-live-SECRET must remain",
      evidence: [{ id: "e1", excerpt: "restore-ambiguous" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("secret");
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });

  test("reviews ordinary evidence", () => {
    const result = adviseOutcome({
      mode: "review",
      question: "Does restore refuse collisions?",
      evidence: [{ id: "e1", excerpt: "restore-ambiguous on collision" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.findings).toHaveLength(1);
    }
  });
});
