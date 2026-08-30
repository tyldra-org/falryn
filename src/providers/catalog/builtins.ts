/** Built-in catalog resources compiled into every Falryn executable. */

import type { ProviderAdapterKind } from "../adapter-kind.ts";
import type { ModelCapabilityDeclaration } from "../model-capability.ts";
import anthropicCatalogValue from "./builtin/anthropic.json";
import commandCodeCatalogValue from "./builtin/commandcode.json";
import googleCatalogValue from "./builtin/google.json";
import openAiCatalogValue from "./builtin/openai.json";
import type { ModelCatalogDocument } from "./contracts.ts";
import { parseModelCatalogDocument } from "./schema.ts";

function requiredBuiltin(value: unknown): ModelCatalogDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    !("models" in value) ||
    !Array.isArray(value.models) ||
    value.models.some(
      (model) =>
        typeof model !== "object" ||
        model === null ||
        !("pricing" in model) ||
        !("responseDensityControls" in model) ||
        !("promptCacheModes" in model) ||
        !Array.isArray(model.promptCacheModes) ||
        model.promptCacheModes.length === 0,
    )
  ) {
    throw new Error("Falryn's built-in model catalog omits required capability-depth facts.");
  }
  const parsed = parseModelCatalogDocument(value);
  if (!parsed.ok) {
    throw new Error("Falryn was built with an invalid model catalog resource.");
  }
  if (
    parsed.value.models.some(
      (model) =>
        model.pricing === undefined ||
        (model.pricing.kind !== "unknown" &&
          (model.pricing.sourceUrl === null || model.pricing.observedAt === null)) ||
        ((model.promptCacheModes ?? []).length > 0 &&
          (model.pricing === undefined ||
            model.pricing.tiers.length === 0 ||
            model.pricing.tiers.some(
              (tier) => tier.usdMicrosPerMillionTokens.cachedInput === null,
            ))),
    )
  ) {
    throw new Error("Falryn's built-in model catalog omits pricing provenance or cache rates.");
  }
  return parsed.value;
}

export const BUILTIN_MODEL_CATALOGS: readonly ModelCatalogDocument[] = [
  requiredBuiltin(openAiCatalogValue),
  requiredBuiltin(anthropicCatalogValue),
  requiredBuiltin(googleCatalogValue),
  requiredBuiltin(commandCodeCatalogValue),
];

function normalizedEndpoint(value: string | null): string | null {
  return value?.replace(/\/+$/u, "") ?? null;
}

export function builtinModelCatalog(
  adapterKind: ProviderAdapterKind,
  provider: string,
  endpoint: string | null,
): ModelCatalogDocument | null {
  return (
    BUILTIN_MODEL_CATALOGS.find(
      (catalog) =>
        catalog.provider.adapterKind === adapterKind &&
        String(catalog.provider.providerId) === provider &&
        normalizedEndpoint(catalog.provider.endpoint) === normalizedEndpoint(endpoint),
    ) ?? null
  );
}

export function builtinModelCapability(
  adapterKind: ProviderAdapterKind,
  provider: string,
  id: string,
  endpoint: string | null,
): ModelCapabilityDeclaration | null {
  return (
    builtinModelCatalog(adapterKind, provider, endpoint)?.models.find(
      (model) => String(model.modelId) === id,
    ) ?? null
  );
}
