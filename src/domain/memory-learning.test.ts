/**
 * Operational observations stay aggregates; recommendations stay suggestions.
 */

import { describe, expect, test } from "bun:test";

import { observationId, recommendationId, workspaceId } from "./identity.ts";
import {
  defineOperationalObservation,
  defineOperationalRecommendation,
  MEMORY_LEARNING_VERSION,
} from "./memory-learning.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);
const LATER = timestampFromEpochMilliseconds(1_700_000_360_000);

function observation(overrides: Record<string, unknown> = {}) {
  return {
    observationId: "obs-1",
    class: "tool",
    identity: "shell.exec",
    outcome: "failure",
    sampleCount: 8,
    latencyBucket: "200-1000ms",
    createdAt: NOW,
    ...overrides,
  };
}

describe("defineOperationalObservation", () => {
  test("admits a bounded aggregate without storing prompts or source text", () => {
    const result = defineOperationalObservation(observation());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.schemaVersion).toBe(MEMORY_LEARNING_VERSION);
    expect(result.value.observationId).toBe(observationId.from("obs-1"));
    expect(result.value.identity).toBe("shell.exec");
  });

  test("refuses prompt, source, and transcript fields", () => {
    expect(defineOperationalObservation(observation({ prompt: "run tests" }))).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "prompt" },
    });
    expect(defineOperationalObservation(observation({ source: "turn-1" }))).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "source" },
    });
    expect(defineOperationalObservation(observation({ transcript: "hello" }))).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "transcript" },
    });
  });
});

describe("defineOperationalRecommendation", () => {
  test("records supporting observations and counterexamples as a suggestion", () => {
    const result = defineOperationalRecommendation({
      recommendationId: "rec-1",
      supporting: ["obs-1"],
      counterexamples: ["obs-2"],
      expectedBenefit: "Prefer ripgrep for path-scoped search.",
      risks: "May miss files excluded from the index.",
      workspaceId: "workspace-1",
      createdAt: NOW,
      expiresAt: LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe("suggested");
    expect(result.value.recommendationId).toBe(recommendationId.from("rec-1"));
    expect(result.value.workspaceId).toBe(workspaceId.from("workspace-1"));
    expect(result.value.supporting).toEqual([observationId.from("obs-1")]);
  });

  test("cancels before proposing a recommendation", () => {
    expect(
      defineOperationalRecommendation({
        recommendationId: "rec-1",
        supporting: ["obs-1"],
        expectedBenefit: "x",
        risks: "y",
        createdAt: NOW,
        cancelled: true,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "memory", code: "cancelled", field: "signal" },
    });
  });
});
