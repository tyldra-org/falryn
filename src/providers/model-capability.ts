/** Provider-neutral model facts used by discovery and routing. */

import type { ModelId } from "../domain/identity.ts";
import { type ModelPricing, unknownModelPricing } from "./model-pricing.ts";

export const MODEL_CAPABILITY_SCHEMA_VERSION = 1;

export const MODEL_INPUT_MODALITIES = ["text", "image", "audio", "video", "document"] as const;
export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];

export const MODEL_OUTPUT_MODALITIES = ["text", "image", "audio", "video"] as const;
export type ModelOutputModality = (typeof MODEL_OUTPUT_MODALITIES)[number];

export const MODEL_FEATURE_SUPPORTS = ["supported", "unsupported", "unknown"] as const;
export type ModelFeatureSupport = (typeof MODEL_FEATURE_SUPPORTS)[number];

/** Provider-neutral response-density values that provider adapters may translate natively. */
export const MODEL_RESPONSE_DENSITY_CONTROLS = ["low", "medium", "high"] as const;
export type ModelResponseDensityControl = (typeof MODEL_RESPONSE_DENSITY_CONTROLS)[number];

/** Exact provider cache mechanism verified for a model and transport. */
export const MODEL_PROMPT_CACHE_MODES = [
  "implicit-prefix",
  "openai-routing-key",
  "anthropic-ephemeral",
  "google-explicit-resource",
  "provider-managed",
] as const;
export type ModelPromptCacheMode = (typeof MODEL_PROMPT_CACHE_MODES)[number];

export const MODEL_CAPABILITY_COMPLETENESSES = ["complete", "partial"] as const;
export type ModelCapabilityCompleteness = (typeof MODEL_CAPABILITY_COMPLETENESSES)[number];

export const MODEL_AVAILABILITIES = ["available", "unavailable", "unknown"] as const;
export type ModelAvailability = (typeof MODEL_AVAILABILITIES)[number];

export const MODEL_CAPABILITY_PROVENANCES = [
  "profile-declaration",
  "user-catalog",
  "falryn-builtin",
  "provider-manifest",
  "remote-identity",
  "compatibility-default",
] as const;
export type ModelCapabilityProvenance = (typeof MODEL_CAPABILITY_PROVENANCES)[number];

/** Secret-free model facts that may be persisted in a provider profile. */
export type ModelCapabilityDeclaration = {
  readonly schemaVersion: typeof MODEL_CAPABILITY_SCHEMA_VERSION;
  readonly modelId: ModelId;
  readonly displayName: string | null;
  readonly inputModalities: readonly ModelInputModality[];
  readonly outputModalities: readonly ModelOutputModality[];
  readonly tools: ModelFeatureSupport;
  readonly structuredOutput: ModelFeatureSupport;
  readonly streaming: ModelFeatureSupport;
  readonly reasoning: ModelFeatureSupport;
  /** Provider-native values such as low, medium, high, or a token budget mode. */
  readonly reasoningControls: readonly string[];
  /** Native response-density controls confirmed for this exact model. */
  readonly responseDensityControls?: readonly ModelResponseDensityControl[];
  /** Prompt-cache mechanisms confirmed for this exact provider-bound model. */
  readonly promptCacheModes?: readonly ModelPromptCacheMode[];
  /** Published minimum cacheable prefix, or null when the provider does not publish one. */
  readonly promptCacheMinimumInputTokens?: number | null;
  readonly contextTokens: number | null;
  readonly outputTokens: number | null;
  /** Provider-bound, versioned rates. Unknown values are never inferred from names. */
  readonly pricing?: ModelPricing;
  readonly completeness: ModelCapabilityCompleteness;
};

/** One effective record in an immutable catalog generation. */
export type ModelCapability = ModelCapabilityDeclaration & {
  readonly availability: ModelAvailability;
  readonly provenance: readonly ModelCapabilityProvenance[];
};

export function featureIsSupported(value: ModelFeatureSupport): boolean {
  return value === "supported";
}

export function unknownModelCapability(
  model: ModelId,
  options: {
    readonly availability?: ModelAvailability;
    readonly provenance?: readonly ModelCapabilityProvenance[];
  } = {},
): ModelCapability {
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    modelId: model,
    displayName: null,
    inputModalities: [],
    outputModalities: [],
    tools: "unknown",
    structuredOutput: "unknown",
    streaming: "unknown",
    reasoning: "unknown",
    reasoningControls: [],
    responseDensityControls: [],
    promptCacheModes: [],
    promptCacheMinimumInputTokens: null,
    contextTokens: null,
    outputTokens: null,
    pricing: unknownModelPricing(),
    completeness: "partial",
    availability: options.availability ?? "unknown",
    provenance: options.provenance ?? ["compatibility-default"],
  };
}

export function capabilityFromDeclaration(
  declaration: ModelCapabilityDeclaration,
  options: {
    readonly availability?: ModelAvailability;
    readonly provenance?: readonly ModelCapabilityProvenance[];
  } = {},
): ModelCapability {
  return {
    ...declaration,
    promptCacheModes: declaration.promptCacheModes ?? [],
    promptCacheMinimumInputTokens: declaration.promptCacheMinimumInputTokens ?? null,
    pricing: declaration.pricing ?? unknownModelPricing(),
    availability: options.availability ?? "unknown",
    provenance: options.provenance ?? ["profile-declaration"],
  };
}
