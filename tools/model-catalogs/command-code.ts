/** Deterministic source for Command Code's committed built-in catalog resource. */

import { modelId } from "../../src/domain/identity.ts";
import type { ModelCatalogDocument } from "../../src/providers/catalog/contracts.ts";
import { parseModelCatalogDocument } from "../../src/providers/catalog/schema.ts";
import {
  COMMAND_CODE_MODEL_MANIFESTS,
  COMMAND_CODE_OPENAI_BASE_URL,
  COMMAND_CODE_PROVIDER_ID,
  commandCodeReasoningControlsFor,
} from "../../src/providers/command-code.ts";
import { commandCodePricingFor } from "./command-code-pricing.ts";

export function createCommandCodeCatalog(): ModelCatalogDocument {
  const value = {
    schemaVersion: 1,
    catalogId: "falryn.commandcode",
    displayName: "Falryn Command Code catalog",
    provider: {
      providerId: COMMAND_CODE_PROVIDER_ID,
      adapterKind: "commandcode",
      endpoint: COMMAND_CODE_OPENAI_BASE_URL,
    },
    sources: [
      {
        sourceUrl: "https://commandcode.ai/docs/provider",
        observedAt: "2026-08-30T00:00:00Z",
        facts: ["identity", "capabilities"],
        kind: "provider-documentation",
        confidence: "high",
      },
      {
        sourceUrl: "https://commandcode.ai/docs/resources/pricing-limits",
        observedAt: "2026-08-30T00:00:00Z",
        facts: ["identity", "limits", "prompt-cache"],
        kind: "provider-documentation",
        confidence: "high",
      },
    ],
    models: COMMAND_CODE_MODEL_MANIFESTS.map((model) => {
      const reasoningControls = commandCodeReasoningControlsFor(model.id);
      return {
        schemaVersion: 1,
        modelId: modelId.from(model.id),
        displayName: model.name,
        inputModalities: model.image ? ["text", "image"] : ["text"],
        outputModalities: ["text"],
        tools: "supported",
        structuredOutput: "unknown",
        streaming: "supported",
        reasoning: model.reasoning || reasoningControls.length > 0 ? "supported" : "unknown",
        reasoningControls,
        responseDensityControls: [],
        promptCacheModes: ["provider-managed"],
        promptCacheMinimumInputTokens: null,
        contextTokens: model.contextTokens,
        outputTokens: null,
        pricing: commandCodePricingFor(model.id),
        completeness: "partial",
      };
    }),
  };
  const parsed = parseModelCatalogDocument(value);
  if (!parsed.ok) {
    throw new Error("Command Code's generated model catalog is invalid.");
  }
  return parsed.value;
}
