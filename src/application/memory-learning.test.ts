/**
 * Operational learning port: aggregates stay observations, recommendations stay suggested.
 */

import { describe, expect, test } from "bun:test";

import { observationId, timestampFromEpochMilliseconds } from "../domain/index.ts";
import { createOperationalLearning } from "./memory-learning.ts";

const NOW = timestampFromEpochMilliseconds(1_700_000_000_000);

function observation(overrides: Record<string, unknown> = {}) {
  return {
    observationId: "obs-1",
    class: "tool",
    identity: "shell.exec",
    outcome: "failure",
    sampleCount: 8,
    createdAt: NOW,
    ...overrides,
  };
}

describe("createOperationalLearning", () => {
  test("stores observations and a suggested recommendation without applying it", () => {
    const learning = createOperationalLearning();
    expect(learning.record(observation()).ok).toBe(true);
    expect(
      learning.record(
        observation({
          observationId: "obs-2",
          outcome: "success",
          sampleCount: 2,
        }),
      ).ok,
    ).toBe(true);
    const recommended = learning.recommend({
      recommendationId: "rec-1",
      supporting: ["obs-1"],
      counterexamples: ["obs-2"],
      expectedBenefit: "Prefer ripgrep for path-scoped search.",
      risks: "May miss files excluded from the index.",
      createdAt: NOW,
    });
    expect(recommended.ok).toBe(true);
    if (recommended.ok) {
      expect(recommended.value.status).toBe("suggested");
    }
    expect(learning.apply("rec-1")).toEqual({
      ok: false,
      error: { kind: "memory", code: "denied", field: "recommendationId" },
    });
    expect(learning.listRecommendations()).toHaveLength(1);
    const stored = learning.observation("obs-1");
    expect(stored.ok).toBe(true);
    if (stored.ok) {
      expect(stored.value.observationId).toBe(observationId.from("obs-1"));
    }
  });

  test("refuses secret-shaped recommendation text and unknown supporting observations", () => {
    const learning = createOperationalLearning();
    expect(learning.record(observation()).ok).toBe(true);
    expect(
      learning.recommend({
        recommendationId: "rec-secret",
        supporting: ["obs-1"],
        expectedBenefit: "token sk-live-SECRET-MUST-NOT-ESCAPE",
        risks: "none",
        createdAt: NOW,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "memory", code: "secret", field: "expectedBenefit" },
    });
    expect(
      learning.recommend({
        recommendationId: "rec-missing",
        supporting: ["obs-missing"],
        expectedBenefit: "Prefer ripgrep.",
        risks: "Index gaps.",
        createdAt: NOW,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "memory", code: "unavailable", field: "supporting" },
    });
  });
});
