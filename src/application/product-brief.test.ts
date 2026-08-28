/**
 * Product Brief controls (#717).
 */

import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  invocationId,
  sessionId,
  turnId,
} from "../domain/index.ts";
import {
  briefNeedAfterContext,
  briefNeedAfterToolResults,
  composeProductBriefControls,
  deriveProductBriefNeed,
  PRODUCT_BRIEF_OWNER,
} from "./product-brief.ts";

describe("composeProductBriefControls", () => {
  test("projects user verbosity into a required brief section", () => {
    const brief = composeProductBriefControls({ initialVerbosity: "compact" });
    expect(brief.owner).toBe(PRODUCT_BRIEF_OWNER);
    expect(brief.getVerbosity()).toBe("compact");
    const projected = brief.projectForTurn({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      configurationGeneration: configurationGeneration.from(0),
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) {
      return;
    }
    expect(projected.value.section.role).toBe("brief");
    expect(projected.value.projection.receipt.requestedMode).toBe("compact");
  });

  test("rejects unsupported verbosity modes", () => {
    const brief = composeProductBriefControls();
    const set = brief.setVerbosity("loud");
    expect(set.ok).toBe(false);
    expect(brief.getVerbosity()).toBe("balanced");
  });

  test("derives response obligations from the task and degraded context", () => {
    const initial = deriveProductBriefNeed({
      prompt: "Implement and verify this change with cited sources",
      interface: "headless",
    });
    expect(initial).toMatchObject({
      complexity: "high",
      interface: "headless",
      citations: true,
      validation: true,
    });
    expect(
      briefNeedAfterContext(initial, { status: "unavailable", candidateCount: 0 }),
    ).toMatchObject({ uncertainty: true, recovery: true });
  });

  test("protects failures, risks, validation, and recovery after tool results", () => {
    const initial = deriveProductBriefNeed({ prompt: "run it", interface: "interactive" });
    const updated = briefNeedAfterToolResults(initial, [
      {
        invocationId: invocationId.from("brief-tool-1"),
        toolCallId: "call-1",
        toolName: "run_tests",
        capabilityId: capabilityId.from("builtin:test/run@1"),
        effectClass: "mutation",
        outcome: {
          status: "partial",
          output: {},
          effect: "partial",
        },
      },
    ]);
    expect(updated).toMatchObject({
      complexity: "high",
      failures: true,
      risk: true,
      uncertainty: true,
      validation: true,
      recovery: true,
    });
    const brief = composeProductBriefControls({ initialVerbosity: "auto" });
    const projected = brief.projectForTurn({
      turnId: turnId.from("turn-auto-failure"),
      sessionId: sessionId.from("session-auto-failure"),
      configurationGeneration: configurationGeneration.from(0),
      need: updated,
    });
    expect(projected).toMatchObject({
      ok: true,
      value: {
        projection: {
          receipt: { selectedVerbosity: "detailed", outputTokenBudget: 8_192 },
        },
      },
    });
  });
});
