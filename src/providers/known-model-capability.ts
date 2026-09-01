/** Compatibility exports over Falryn's bundled, versioned model catalogs. */

import type { ProviderAdapterKind } from "./adapter-kind.ts";
import { builtinModelCapability, builtinModelCatalog } from "./catalog/builtins.ts";
import type { ModelCapabilityDeclaration } from "./model-capability.ts";

const OPENAI_CATALOG = builtinModelCatalog("openai", "openai", "https://api.openai.com/v1");
if (OPENAI_CATALOG === null) {
  throw new Error("Falryn's built-in OpenAI model catalog is missing.");
}

/** Current general-purpose OpenAI family, ordered for Falryn's default route. */
export const LATEST_OPENAI_MODEL_CAPABILITIES: readonly ModelCapabilityDeclaration[] = [
  ...OPENAI_CATALOG.models.filter((model) => String(model.modelId).startsWith("gpt-5.6")),
];

export const LATEST_OPENAI_MODEL_IDS = LATEST_OPENAI_MODEL_CAPABILITIES.map(
  (capability) => capability.modelId,
);

const GPT_4O_MINI = OPENAI_CATALOG.models.find((model) => String(model.modelId) === "gpt-4o-mini");
if (GPT_4O_MINI === undefined) {
  throw new Error("Falryn's built-in OpenAI catalog is missing GPT-4o mini.");
}
export const KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY = GPT_4O_MINI;

/** Source-verified OpenAI compatibility facts available without remote discovery. */
export const KNOWN_OPENAI_MODEL_CAPABILITIES: readonly ModelCapabilityDeclaration[] = [
  ...OPENAI_CATALOG.models,
];

export function knownModelCapability(
  adapterKind: ProviderAdapterKind,
  id: string,
  endpoint: string | null,
  provider = "openai",
): ModelCapabilityDeclaration | null {
  return builtinModelCapability(adapterKind, provider, id, endpoint);
}
