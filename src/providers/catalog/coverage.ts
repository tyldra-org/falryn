/** Coverage proof for provider-bound model catalog documents. */

import type { ModelCapabilityDeclaration } from "../model-capability.ts";
import type { ModelCatalogDocument } from "./contracts.ts";

export const MODEL_CATALOG_CORE_FACTS = [
  "input-modalities",
  "output-modalities",
  "tools",
  "structured-output",
  "streaming",
  "reasoning",
  "context-limit",
  "output-limit",
  "pricing",
] as const;
export type ModelCatalogCoreFact = (typeof MODEL_CATALOG_CORE_FACTS)[number];

export type ModelCatalogModelCoverage = {
  readonly modelId: string;
  readonly completeness: ModelCapabilityDeclaration["completeness"];
  readonly unresolvedCoreFacts: readonly ModelCatalogCoreFact[];
};

export type ModelCatalogCoverage = {
  readonly modelCount: number;
  readonly completeModelCount: number;
  readonly partialModelCount: number;
  readonly unresolvedCoreFactCounts: Readonly<Record<ModelCatalogCoreFact, number>>;
  readonly modelsWithReasoningControls: number;
  readonly modelsWithResponseDensityControls: number;
  readonly modelsWithKnownPromptCacheMinimum: number;
  readonly models: readonly ModelCatalogModelCoverage[];
};

export function unresolvedModelCatalogCoreFacts(
  model: ModelCapabilityDeclaration,
): readonly ModelCatalogCoreFact[] {
  const facts: ModelCatalogCoreFact[] = [];
  if (model.inputModalities.length === 0) {
    facts.push("input-modalities");
  }
  if (model.outputModalities.length === 0) {
    facts.push("output-modalities");
  }
  if (model.tools === "unknown") {
    facts.push("tools");
  }
  if (model.structuredOutput === "unknown") {
    facts.push("structured-output");
  }
  if (model.streaming === "unknown") {
    facts.push("streaming");
  }
  if (model.reasoning === "unknown") {
    facts.push("reasoning");
  }
  if (model.contextTokens === null) {
    facts.push("context-limit");
  }
  if (model.outputTokens === null) {
    facts.push("output-limit");
  }
  if (model.pricing === undefined || model.pricing.kind === "unknown") {
    facts.push("pricing");
  }
  return facts;
}

export function inspectModelCatalogCoverage(catalog: ModelCatalogDocument): ModelCatalogCoverage {
  const unresolvedCoreFactCounts = Object.fromEntries(
    MODEL_CATALOG_CORE_FACTS.map((fact) => [fact, 0]),
  ) as Record<ModelCatalogCoreFact, number>;
  const models = catalog.models.map((model): ModelCatalogModelCoverage => {
    const unresolvedCoreFacts = unresolvedModelCatalogCoreFacts(model);
    for (const fact of unresolvedCoreFacts) {
      unresolvedCoreFactCounts[fact] += 1;
    }
    return {
      modelId: String(model.modelId),
      completeness: model.completeness,
      unresolvedCoreFacts,
    };
  });

  return {
    modelCount: models.length,
    completeModelCount: models.filter((model) => model.completeness === "complete").length,
    partialModelCount: models.filter((model) => model.completeness === "partial").length,
    unresolvedCoreFactCounts,
    modelsWithReasoningControls: catalog.models.filter(
      (model) => model.reasoningControls.length > 0,
    ).length,
    modelsWithResponseDensityControls: catalog.models.filter(
      (model) => (model.responseDensityControls?.length ?? 0) > 0,
    ).length,
    modelsWithKnownPromptCacheMinimum: catalog.models.filter(
      (model) =>
        model.promptCacheMinimumInputTokens !== null &&
        model.promptCacheMinimumInputTokens !== undefined,
    ).length,
    models,
  };
}

export function incompleteCompleteModelIds(coverage: ModelCatalogCoverage): readonly string[] {
  return coverage.models
    .filter((model) => model.completeness === "complete" && model.unresolvedCoreFacts.length > 0)
    .map((model) => model.modelId);
}
