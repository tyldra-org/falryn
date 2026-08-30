import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { compareBriefPair } from "../src/domain/index.ts";
import {
  createBriefScorecardProvider,
  formatBriefScorecardHuman,
  responseContainsBriefFact,
  type ScorecardReport,
} from "./brief-scorecard.ts";
import qualification from "./fixtures/brief-qualification-commandcode-minimax-m3.json";
import { BRIEF_RESPONSE_FIXTURES } from "./fixtures/brief-response-corpus.ts";

describe("Brief scorecard", () => {
  test("normalizes presentation without accepting changed fact wording", () => {
    expect(
      responseContainsBriefFact("**Do not run** `reset --hard`.", "do not run reset --hard"),
    ).toBe(true);
    expect(responseContainsBriefFact("Do  not\nrun reset --hard.", "do not run reset --hard")).toBe(
      true,
    );
    expect(
      responseContainsBriefFact("Never run git reset --hard.", "do not run reset --hard"),
    ).toBe(false);
    expect(responseContainsBriefFact("Run reset --hard.", "do not run reset --hard")).toBe(false);
  });

  test("selects Command Code MiniMax M3 through the verified provider adapter", async () => {
    const provider = await createBriefScorecardProvider({
      FALRYN_BRIEF_PROVIDER: "commandcode",
      FALRYN_COMMANDCODE_API_KEY: "test-only-key",
    });

    expect(String(provider.adapter.identity.providerId)).toBe("commandcode");
    expect(provider.adapter.identity.adapterKind).toBe("commandcode");
    expect(provider.model).toBe("MiniMaxAI/MiniMax-M3");
    expect(provider.catalog.models.map((model) => String(model.modelId))).toEqual([
      "MiniMaxAI/MiniMax-M3",
    ]);
  });

  test("fails closed when the selected provider has no credential", async () => {
    await expect(
      createBriefScorecardProvider({ FALRYN_BRIEF_PROVIDER: "commandcode" }),
    ).rejects.toThrow("FALRYN_COMMANDCODE_API_KEY");
  });

  test("accepts every documented Command Code and Falryn compatibility alias", async () => {
    for (const variable of [
      "FALRYN_COMMAND_CODE_API_KEY",
      "FALRYN_CMD_API_KEY",
      "COMMAND_CODE_API_KEY",
      "CMD_API_KEY",
      "COMMANDCODE_API_KEY",
    ]) {
      const provider = await createBriefScorecardProvider({
        FALRYN_BRIEF_PROVIDER: "commandcode",
        [variable]: "test-only-key",
      });
      expect(provider.model).toBe("MiniMaxAI/MiniMax-M3");
    }
  });

  test("rejects an unsupported provider identity", async () => {
    await expect(
      createBriefScorecardProvider({ FALRYN_BRIEF_PROVIDER: "compatible" }),
    ).rejects.toThrow("unsupported Brief scorecard provider: compatible");
  });

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
      schemaVersion: 2,
      generatedAt: "2026-08-27T00:00:00.000Z",
      baseline: { commit: "commit", sourceDigest: "digest", adapterVersion: "adapter" },
      provider: { id: "provider", model: "model" },
      settings: {
        repetitions: 1,
        outputTokenLimit: 2_048,
        responseTokenizer: "tokenizer",
        concurrency: 1,
        toolExposure: "none",
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
    expect(human).toContain("mode=compact delivery=prompt native=none");
    expect(human).toContain("tokens(total/input/output/cache/reasoning)=100/90/10/0/0");
    expect(human).toContain("requests=1 retries=0");
    expect(human).toContain('required=["fact"] preserved=["fact"] missingFacts=[]');
  });

  test("retains the reviewed live qualification without raw model content", () => {
    expect(qualification.summary).toEqual({
      total: 12,
      passed: 12,
      tied: 0,
      lost: 0,
      invalid: 0,
      accepted: 12,
      partial: false,
      complete: true,
    });
    expect(qualification.rows).toHaveLength(BRIEF_RESPONSE_FIXTURES.length * 2);
    expect(qualification.rows.map((row) => row.pairId)).toEqual(
      BRIEF_RESPONSE_FIXTURES.flatMap((fixture) => [`${fixture.id}-1`, `${fixture.id}-2`]),
    );
    expect(qualification.rows.every((row) => row.briefFidelity === 1)).toBe(true);
    expect(qualification.rows.every((row) => row.verdict === "pass" && row.accepted)).toBe(true);
    expect(qualification.settings).toMatchObject({
      briefDelivery: "prompt",
      providerResponseDensityControl: null,
      toolExposure: "none",
    });
    expect(qualification.aggregate.briefMissingFacts).toBe(0);
    expect(qualification.rows.reduce((total, row) => total + row.tokenDelta, 0)).toBe(
      qualification.aggregate.tokenDelta,
    );
    expect(qualification.aggregate.briefTotalTokens).toBeLessThan(
      qualification.aggregate.cavemanTotalTokens,
    );
    expect(qualification.sourceReportDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(createHash("sha256").update(JSON.stringify(BRIEF_RESPONSE_FIXTURES)).digest("hex")).toBe(
      qualification.fixtureCorpusDigest,
    );
    expect(JSON.stringify(qualification)).not.toMatch(
      /(?:responseText|promptText|apiKey|credentialValue)/u,
    );
  });
});

function arm(policy: "brief" | "caveman", inputTokens: number, outputTokens: number) {
  return {
    policy,
    policyMode: policy === "brief" ? "compact" : "ultra",
    delivery: "prompt" as const,
    providerResponseDensityControl: null,
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
      totalProvenance: "provider-reported" as const,
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
