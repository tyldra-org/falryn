import { describe, expect, test } from "bun:test";

import { compareBriefPair } from "../src/domain/index.ts";
import { formatBriefScorecardHuman, type ScorecardReport } from "./brief-scorecard.ts";
import { BRIEF_RESPONSE_FIXTURES } from "./fixtures/brief-response-corpus.ts";

describe("Brief scorecard", () => {
  test("covers all reviewed categories, Brief levels, and Caveman intensities", () => {
    expect(new Set(BRIEF_RESPONSE_FIXTURES.map((fixture) => fixture.category)).size).toBe(6);
    expect(new Set(BRIEF_RESPONSE_FIXTURES.map((fixture) => fixture.briefMode))).toEqual(
      new Set(["compact", "balanced", "detailed"]),
    );
    expect(new Set(BRIEF_RESPONSE_FIXTURES.map((fixture) => fixture.cavemanIntensity))).toEqual(
      new Set(["lite", "full", "ultra"]),
    );
  });

  test("renders human output from the same immutable result facts as JSON", () => {
    const result = compareBriefPair({
      pairId: "fixture-1",
      brief: arm("brief", 90, 10),
      caveman: arm("caveman", 120, 20),
    });
    const report: ScorecardReport = {
      schemaVersion: 1,
      generatedAt: "2026-08-27T00:00:00.000Z",
      baseline: { commit: "commit", sourceDigest: "digest", adapterVersion: "adapter" },
      provider: { id: "provider", model: "model" },
      settings: {
        repetitions: 1,
        outputTokenLimit: 2_048,
        responseTokenizer: "tokenizer",
        concurrency: 1,
      },
      attempts: [arm("brief", 90, 10), arm("caveman", 120, 20)],
      pairs: [
        { pairId: "fixture-1", brief: arm("brief", 90, 10), caveman: arm("caveman", 120, 20) },
      ],
      results: [result],
      summary: {
        total: 1,
        passed: 1,
        tied: 0,
        lost: 0,
        invalid: 0,
        accepted: 1,
        partial: false,
        complete: true,
      },
    };
    expect(JSON.parse(JSON.stringify(report)).results[0].verdict).toBe("pass");
    const human = formatBriefScorecardHuman(report);
    expect(human).toContain("fixture-1");
    expect(human).toContain("verdict=pass");
    expect(human).toContain("tokens(total/input/output/cache/reasoning)=100/90/10/0/0");
    expect(human).toContain("requests=1 retries=0");
    expect(human).toContain('required=["fact"] preserved=["fact"] missingFacts=[]');
  });
});

function arm(policy: "brief" | "caveman", inputTokens: number, outputTokens: number) {
  return {
    policy,
    policyMode: policy === "brief" ? "compact" : "ultra",
    policyDigest: `${policy}-digest`,
    guidanceBytes: 10,
    guidanceTokensEstimated: 3,
    match: {
      taskDigest: "task",
      fixtureDigest: "fixture",
      workspaceDigest: "workspace",
      instructionDigest: "instructions",
      evidenceDigest: "evidence",
      toolHistoryDigest: "tools",
      provider: "provider",
      model: "model",
      reasoning: "provider-default",
      outputTokenLimit: 2_048,
      cacheState: "cold",
      retryPolicyDigest: "retry",
    },
    order: policy === "brief" ? (1 as const) : (2 as const),
    terminal: "completed" as const,
    usage: {
      provenance: "provider-reported" as const,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    },
    responseBytes: 20,
    responseTokens: 5,
    responseTokenizer: "tokenizer",
    wallTimeMs: 1,
    costUsd: null,
    providerRequests: 1,
    retries: 0,
    requiredFacts: ["fact"],
    preservedFacts: ["fact"],
    missingFacts: [],
    unsupportedClaims: 0,
  };
}
