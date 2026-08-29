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
  classifyProductBriefComplexity,
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
    expect(projected?.ok).toBe(true);
    if (projected === null || !projected.ok) {
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

  test("exposes off while retaining raw only as the backend bypass", () => {
    const brief = composeProductBriefControls({ initialVerbosity: "detailed" });
    expect(brief.setFrontendMode("off")).toEqual({ ok: true, value: "off" });
    expect(brief.getFrontendMode()).toBe("off");
    expect(brief.getVerbosity()).toBe("raw");
    expect(
      brief.requestForTurn({
        turnId: turnId.from("turn-brief-off"),
        sessionId: sessionId.from("session-brief-off"),
        configurationGeneration: configurationGeneration.from(0),
      }),
    ).toBeNull();
    expect(brief.setFrontendMode("on")).toEqual({ ok: true, value: "on" });
    expect(brief.getFrontendMode()).toBe("detailed");
    expect(brief.getVerbosity()).toBe("detailed");
  });

  test("derives response obligations from the task and degraded context", () => {
    const initial = deriveProductBriefNeed({
      prompt: "Implement and verify this change with cited sources",
      interface: "headless",
    });
    expect(initial).toMatchObject({
      complexity: "medium",
      interface: "headless",
      citations: true,
      validation: true,
    });
    expect(
      briefNeedAfterContext(initial, { status: "unavailable", candidateCount: 0 }),
    ).toMatchObject({ uncertainty: true, recovery: true });
  });

  test("classifies task shape into low, medium, and high complexity", () => {
    expect(classifyProductBriefComplexity("What changed?")).toBe("low");
    expect(classifyProductBriefComplexity("Implement and verify this change")).toBe("medium");
    expect(classifyProductBriefComplexity("Audit the provider path and compare its retries")).toBe(
      "high",
    );
    expect(
      classifyProductBriefComplexity(
        [
          "Please handle these:",
          "- inspect auth",
          "- update config",
          "- run tests",
          "- report",
        ].join("\n"),
      ),
    ).toBe("high");
    expect(classifyProductBriefComplexity("x".repeat(1_201))).toBe("high");
  });

  test("protects obligations stated directly in the user request", () => {
    expect(
      deriveProductBriefNeed({
        prompt:
          "Report the failed check and required fix. Recovery uses artifact-42; uncertainty remains. This needs user approval before retrying.",
        interface: "headless",
      }),
    ).toMatchObject({
      failures: true,
      uncertainty: true,
      confirmation: true,
      requiredAction: true,
      recovery: true,
    });
  });

  test("detects clarity escapes without imposing a writing voice", () => {
    expect(
      deriveProductBriefNeed({
        prompt:
          "Clarify this irreversible production reset step-by-step. First verify backup, then run reset --hard.",
        interface: "headless",
      }),
    ).toMatchObject({
      safetyCritical: true,
      clarification: true,
      orderedProcedure: true,
    });
  });

  test("keeps an ordinary tool failure balanced unless recovery is uncertain", () => {
    const initial = deriveProductBriefNeed({ prompt: "Run the check", interface: "headless" });
    const updated = briefNeedAfterToolResults(initial, [
      {
        invocationId: invocationId.from("brief-tool-failed"),
        toolCallId: "call-failed",
        toolName: "run_tests",
        capabilityId: capabilityId.from("builtin:test/run@1"),
        effectClass: "observation",
        outcome: { status: "failed", reason: "one test failed", effect: "none" },
      },
    ]);
    expect(updated).toMatchObject({ complexity: "low", failures: true, recovery: false });

    const brief = composeProductBriefControls({ initialVerbosity: "auto" });
    const projected = brief.projectForTurn({
      turnId: turnId.from("turn-auto-failed"),
      sessionId: sessionId.from("session-auto-failed"),
      configurationGeneration: configurationGeneration.from(0),
      need: updated,
    });
    expect(projected).toMatchObject({
      ok: true,
      value: {
        projection: {
          receipt: {
            selectedVerbosity: "balanced",
            selectionReasons: ["failure"],
            outputTokenBudget: 4_096,
          },
        },
      },
    });
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
