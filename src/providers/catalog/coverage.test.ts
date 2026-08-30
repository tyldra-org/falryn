import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../../domain/identity.ts";
import { unknownModelPricing } from "../model-pricing.ts";
import type { ModelCatalogDocument } from "./contracts.ts";
import {
  incompleteCompleteModelIds,
  inspectModelCatalogCoverage,
  unresolvedModelCatalogCoreFacts,
} from "./coverage.ts";

const unresolvedModel = {
  schemaVersion: 1 as const,
  modelId: modelId.from("unknown-model"),
  displayName: "Unknown model",
  inputModalities: [],
  outputModalities: [],
  tools: "unknown" as const,
  structuredOutput: "unknown" as const,
  streaming: "unknown" as const,
  reasoning: "unknown" as const,
  reasoningControls: [],
  responseDensityControls: [],
  promptCacheModes: [],
  promptCacheMinimumInputTokens: null,
  contextTokens: null,
  outputTokens: null,
  pricing: unknownModelPricing(),
  completeness: "partial" as const,
};

function catalog(completeness: "complete" | "partial"): ModelCatalogDocument {
  return {
    schemaVersion: 1,
    catalogId: "coverage-fixture",
    displayName: "Coverage fixture",
    provider: {
      providerId: providerId.from("coverage"),
      adapterKind: "openai",
      endpoint: "https://api.example.test/v1",
    },
    sources: [],
    models: [{ ...unresolvedModel, completeness }],
  };
}

describe("model catalog coverage", () => {
  test("names every unresolved core fact without treating empty control lists as support", () => {
    expect(unresolvedModelCatalogCoreFacts(unresolvedModel)).toEqual([
      "input-modalities",
      "output-modalities",
      "tools",
      "structured-output",
      "streaming",
      "reasoning",
      "context-limit",
      "output-limit",
      "pricing",
    ]);

    const coverage = inspectModelCatalogCoverage(catalog("partial"));
    expect(coverage).toMatchObject({
      modelCount: 1,
      completeModelCount: 0,
      partialModelCount: 1,
      modelsWithReasoningControls: 0,
      modelsWithResponseDensityControls: 0,
      modelsWithKnownPromptCacheMinimum: 0,
    });
    expect(incompleteCompleteModelIds(coverage)).toEqual([]);
  });

  test("rejects the semantic claim when an unresolved built-in is marked complete", () => {
    expect(incompleteCompleteModelIds(inspectModelCatalogCoverage(catalog("complete")))).toEqual([
      "unknown-model",
    ]);
  });
});
