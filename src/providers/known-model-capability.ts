/** Small source-verified capability manifest for Falryn's built-in defaults. */

import { modelId } from "../domain/identity.ts";
import type { ProviderAdapterKind } from "./adapter-kind.ts";
import {
  MODEL_CAPABILITY_SCHEMA_VERSION,
  type ModelCapabilityDeclaration,
} from "./model-capability.ts";

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

export function knownModelCapability(
  adapterKind: ProviderAdapterKind,
  id: string,
  endpoint: string | null,
): ModelCapabilityDeclaration | null {
  const officialOpenAiEndpoint = endpoint?.replace(/\/+$/u, "") === "https://api.openai.com/v1";
  return adapterKind === "openai" && officialOpenAiEndpoint && id === "gpt-4o-mini"
    ? KNOWN_OPENAI_GPT_4O_MINI_CAPABILITY
    : null;
}
