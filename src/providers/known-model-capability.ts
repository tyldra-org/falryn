/** Small source-verified capability manifest for Falryn's built-in defaults. */

import { modelId } from "../domain/identity.ts";
import type { ProviderAdapterKind } from "./adapter-kind.ts";
import {
  MODEL_CAPABILITY_SCHEMA_VERSION,
  type ModelCapabilityDeclaration,
} from "./model-capability.ts";

function openAiGpt56Capability(id: string, displayName: string): ModelCapabilityDeclaration {
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    modelId: modelId.from(id),
    displayName,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    tools: "supported",
    structuredOutput: "supported",
    streaming: "supported",
    reasoning: "supported",
    reasoningControls: ["none", "low", "medium", "high", "xhigh", "max"],
    contextTokens: 1_050_000,
    outputTokens: 128_000,
    completeness: "complete",
  };
}

/** Current general-purpose OpenAI family, ordered for Falryn's default route. */
export const LATEST_OPENAI_MODEL_CAPABILITIES: readonly ModelCapabilityDeclaration[] = [
  openAiGpt56Capability("gpt-5.6-sol", "GPT-5.6 Sol"),
  openAiGpt56Capability("gpt-5.6-terra", "GPT-5.6 Terra"),
  openAiGpt56Capability("gpt-5.6-luna", "GPT-5.6 Luna"),
  openAiGpt56Capability("gpt-5.6", "GPT-5.6"),
];

export const LATEST_OPENAI_MODEL_IDS = LATEST_OPENAI_MODEL_CAPABILITIES.map(
  (capability) => capability.modelId,
);

export const KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY: ModelCapabilityDeclaration = {
  schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
  modelId: modelId.from("gpt-4o-mini"),
  displayName: "GPT-4o mini",
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  tools: "supported",
  structuredOutput: "supported",
  streaming: "supported",
  reasoning: "unsupported",
  reasoningControls: [],
  contextTokens: 128_000,
  outputTokens: 16_384,
  completeness: "complete",
};

/** Source-verified OpenAI compatibility facts available without remote discovery. */
export const KNOWN_OPENAI_MODEL_CAPABILITIES: readonly ModelCapabilityDeclaration[] = [
  ...LATEST_OPENAI_MODEL_CAPABILITIES,
  KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY,
];

const KNOWN_OPENAI_CAPABILITIES_BY_ID = new Map(
  KNOWN_OPENAI_MODEL_CAPABILITIES.map((capability) => [String(capability.modelId), capability]),
);

export function knownModelCapability(
  adapterKind: ProviderAdapterKind,
  id: string,
  endpoint: string | null,
): ModelCapabilityDeclaration | null {
  const officialOpenAiEndpoint = endpoint?.replace(/\/+$/u, "") === "https://api.openai.com/v1";
  if (adapterKind !== "openai" || !officialOpenAiEndpoint) {
    return null;
  }
  return KNOWN_OPENAI_CAPABILITIES_BY_ID.get(id) ?? null;
}
