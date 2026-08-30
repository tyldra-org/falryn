/** Built-in catalog resources compiled into every Falryn executable. */

import type { ProviderAdapterKind } from "../adapter-kind.ts";
import {
  COMMAND_CODE_MODEL_CAPABILITIES,
  COMMAND_CODE_OPENAI_BASE_URL,
  COMMAND_CODE_PROVIDER_ID,
} from "../command-code.ts";
import type { ModelCapabilityDeclaration } from "../model-capability.ts";
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
        !("responseDensityControls" in model),
    )
  ) {
    throw new Error("Falryn's built-in model catalog omits required capability-depth facts.");
  }
  const parsed = parseModelCatalogDocument(value);
  if (!parsed.ok) {
    throw new Error("Falryn was built with an invalid model catalog resource.");
  }
  return parsed.value;
}

export const BUILTIN_MODEL_CATALOGS: readonly ModelCatalogDocument[] = [
  requiredBuiltin(openAiCatalogValue),
  requiredBuiltin({
    schemaVersion: 1,
    catalogId: "falryn.commandcode",
    displayName: "Falryn Command Code catalog",
    provider: {
      providerId: COMMAND_CODE_PROVIDER_ID,
      adapterKind: "commandcode",
      endpoint: COMMAND_CODE_OPENAI_BASE_URL,
    },
    models: COMMAND_CODE_MODEL_CAPABILITIES,
  }),
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
