import { describe, expect, test } from "bun:test";

import type { BriefComparisonArm, BriefComparisonPair } from "./comparison.ts";
import { compareBriefPair } from "./comparison.ts";

function arm(overrides: Partial<BriefComparisonArm> = {}): BriefComparisonArm {
  return {
    policy: "brief",
    policyMode: "compact",
    delivery: "prompt",
    providerResponseDensityControl: null,
    policyDigest: "policy-brief",
    guidanceBytes: 100,
    guidanceTokensEstimated: 25,
    match: {
      taskDigest: "task",
      fixtureDigest: "fixture",
      workspaceDigest: "workspace",
      instructionDigest: "instructions",
      evidenceDigest: "evidence",
      toolHistoryDigest: "tools",
      provider: "provider",
      model: "model",
      reasoning: "balanced",
      outputTokenLimit: 2_048,
      cacheState: "cold",
      retryPolicyDigest: "retry",
    },
    order: 1,
    terminal: "completed",
    usage: {
      provenance: "provider-reported",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      totalProvenance: "provider-reported",
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    responseBytes: 60,
    responseTokens: 20,
    responseTokenizer: "fixture-tokenizer.v1",
    wallTimeMs: 10,
    costUsd: null,
    providerRequests: 1,
    retries: 0,
    requiredFacts: ["error", "command"],
    preservedFacts: ["error", "command"],
    missingFacts: [],
    unsupportedClaims: 0,
    ...overrides,
  };
}

function pair(
  briefOverrides: Partial<BriefComparisonArm> = {},
  cavemanOverrides: Partial<BriefComparisonArm> = {},
): BriefComparisonPair {
  const brief = arm(briefOverrides);
  return {
    pairId: "pair-1",
    brief,
    caveman: arm({
      ...cavemanOverrides,
      policy: "caveman",
      policyMode: "full",
      policyDigest: "policy-caveman",
      order: 2,
      usage: cavemanOverrides.usage ?? {
        provenance: "provider-reported",
        inputTokens: 130,
        outputTokens: 30,
        totalTokens: 160,
        totalProvenance: "provider-reported",
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    }),
  };
}

describe("compareBriefPair", () => {
  test("passes only a matched lower-token full-fidelity row", () => {
    expect(compareBriefPair(pair())).toMatchObject({ verdict: "pass", accepted: true });
  });

  test("invalidates input mismatch, baseline drift, cancellation, and provider failure", () => {
    const mismatched = pair({}, { match: { ...arm().match, model: "other" } });
    expect(compareBriefPair(mismatched).invalidReason).toBe("mismatched-input");
    expect(compareBriefPair(pair({}, { terminal: "baseline-drift" })).invalidReason).toBe(
      "baseline-drift",
    );
    expect(compareBriefPair(pair({ terminal: "cancelled" })).invalidReason).toBe("cancelled");
    expect(compareBriefPair(pair({}, { terminal: "provider-failure" })).invalidReason).toBe(
      "provider-failure",
    );
    expect(compareBriefPair(pair({ terminal: "partial" })).invalidReason).toBe("partial-run");
  });

  test("treats missing usage as invalid instead of zero", () => {
    expect(compareBriefPair(pair({ usage: null }))).toMatchObject({
      verdict: "invalid",
      invalidReason: "missing-usage",
      briefComparableTokens: null,
    });
  });

  test("loses on fact loss, unsupported claims, or more complete-turn tokens", () => {
    expect(
      compareBriefPair(pair({ missingFacts: ["command"], preservedFacts: ["error"] })).verdict,
    ).toBe("loss");
    expect(compareBriefPair(pair({ unsupportedClaims: 1 })).verdict).toBe("loss");
    expect(
      compareBriefPair(
        pair({
          usage: {
            provenance: "provider-reported",
            inputTokens: 200,
            outputTokens: 30,
            totalTokens: 230,
            totalProvenance: "provider-reported",
            cachedInputTokens: 0,
            reasoningTokens: 0,
          },
        }),
      ).reason,
    ).toContain("more");
  });

  test("accepts a token tie only when Brief fidelity is strictly better", () => {
    const usage = arm().usage;
    expect(compareBriefPair(pair({ usage }, { usage })).accepted).toBe(false);
    expect(
      compareBriefPair(
        pair(
          { usage },
          {
            usage,
            preservedFacts: ["error"],
            missingFacts: ["command"],
          },
        ),
      ),
    ).toMatchObject({ verdict: "tie", accepted: true });
  });
});
