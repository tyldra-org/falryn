/** Direct OpenAI processing qualification and bounded wire observations. */
import { createHash } from "node:crypto";
import type { ModelId } from "../../domain/foundation/identity.ts";
import type { ProcessingObservation } from "../../domain/sessions/model-processing.ts";
import { knownModelCapability } from "../../providers/catalog/known-model-capability.ts";
import type { ProviderConnection } from "../../providers/configuration/connection.ts";
import type { ProcessingQualification } from "../../providers/configuration/processing.ts";
import type { ProviderTransportCompatibilityPlan } from "../../providers/configuration/transport-compatibility.ts";
import type { ProviderAdapterPort } from "../../providers/protocol/port.ts";
import type { ModelRequest } from "../../providers/protocol/request.ts";
import { providerDestinationId } from "./provider-destination.ts";

export const OPENAI_PROCESSING_VERSION = "openai-7.15.0-processing-v1";
const ENDPOINT = "https://api.openai.com/v1";
// Exact models with documented Fast prices throughout their admitted context range.
const FAST_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-4o-mini",
]);

export type OpenAiProcessingOptions = {
  readonly baseUrl: string;
  readonly providerId?: string;
  readonly profileId: string;
  /** Supplied by the resolved API-key connection owner; never a credential value. */
  readonly processingAccountGeneration?: string;
};

export function openAiAccountGeneration(connection: ProviderConnection): string {
  return createHash("sha256").update(JSON.stringify(connection)).digest("hex");
}

export function openAiProcessing(options: OpenAiProcessingOptions) {
  const provider = options.providerId ?? "openai";
  const destination = providerDestinationId("openai", options.baseUrl);
  const official = provider === "openai" && options.baseUrl.replace(/\/+$/u, "") === ENDPOINT;
  const accountGeneration = options.processingAccountGeneration;
  const authority: Pick<ProviderAdapterPort, "processingAuthority"> =
    accountGeneration === undefined
      ? {}
      : {
          processingAuthority: () => ({
            accountGeneration,
            adapterGeneration: OPENAI_PROCESSING_VERSION,
            authorized: true,
            capacity: "unknown",
          }),
        };
  return {
    port: {
      processingTransportVersion: OPENAI_PROCESSING_VERSION,
      processingModes: official
        ? (["provider-default", "standard", "fast"] as const)
        : (["provider-default"] as const),
      ...authority,
    },
    qualify(
      plan: ProviderTransportCompatibilityPlan,
      model: ModelId,
    ): ProviderTransportCompatibilityPlan {
      if (!official) return plan;
      const operation = plan.declaration.dialect;
      if (operation !== "openai-responses" && operation !== "openai-chat-completions") return plan;
      const pricing = knownModelCapability("openai", model, ENDPOINT)?.pricing;
      const standard = pricing?.tiers
        .filter((tier) => tier.serviceTier === "standard")
        .map((tier) => tier.id);
      const fast = pricing?.tiers
        .filter((tier) => tier.serviceTier === "fast")
        .map((tier) => tier.id);
      // GPT-5.3-Codex's model contract supports Responses only.
      const knownOperation =
        pricing !== undefined && (model !== "gpt-5.3-codex" || operation === "openai-responses");
      const qualifiedFast = knownOperation && FAST_MODELS.has(model);
      const standardIds = standard?.length ? standard : null;
      const allIds =
        qualifiedFast && standardIds && fast?.length ? [...standardIds, ...fast] : null;
      const qualification: ProcessingQualification = {
        providerId: provider,
        destinationId: destination,
        modelId: model,
        operation,
        transportVersion: OPENAI_PROCESSING_VERSION,
        evidenceUrl: "https://developers.openai.com/api/docs/guides/fast-mode",
        checkedAt: "2026-09-15",
        modes: {
          "provider-default": {
            support: "supported",
            nativeParameters: null,
            priceTierIds:
              operation === "openai-responses" && plan.declaration.serviceTier === "default"
                ? standardIds
                : allIds,
          },
          standard: {
            support: knownOperation ? "supported" : "unknown",
            nativeParameters: knownOperation ? { serviceTier: "default", speed: null } : null,
            priceTierIds: knownOperation ? standardIds : null,
          },
          fast: {
            support: qualifiedFast ? "supported" : "unknown",
            nativeParameters: qualifiedFast ? { serviceTier: "fast", speed: null } : null,
            priceTierIds: allIds,
          },
        },
        actualTiers: [
          { nativeTier: "default", mode: "standard" },
          { nativeTier: "fast", mode: "fast" },
          { nativeTier: "priority", mode: "fast" },
        ],
        cachePartitionByMode: false,
      };
      // Admission metadata has its own adapter/account generation. It must not
      // rename the existing wire plan used to recover durable tool continuations.
      return {
        ...plan,
        declaration: { ...plan.declaration, processingQualifications: [qualification] },
      };
    },
    observe(tier: unknown, request: ModelRequest, now: number): ProcessingObservation {
      return openAiProcessingObservation(tier, request, now, official);
    },
    serviceTier(
      request: ModelRequest,
      plan: ProviderTransportCompatibilityPlan,
    ): "fast" | "default" | undefined {
      const binding = request.processing;
      if (!binding || binding.resolvedMode === "provider-default") return undefined;
      const mode = plan.declaration.processingQualifications?.find(
        (entry) =>
          entry.providerId === provider &&
          entry.destinationId === destination &&
          entry.modelId === request.modelId &&
          entry.operation === plan.declaration.dialect,
      )?.modes[binding.resolvedMode];
      const tier = mode?.nativeParameters?.serviceTier;
      if (
        !official ||
        !options.processingAccountGeneration ||
        mode?.support !== "supported" ||
        binding.providerId !== provider ||
        binding.accountId !== options.profileId ||
        binding.destinationId !== destination ||
        binding.modelId !== request.modelId ||
        binding.operation !== plan.declaration.dialect ||
        binding.transportCompatibilityId !== plan.compatibilityId ||
        binding.accountGeneration !== options.processingAccountGeneration ||
        binding.adapterGeneration !== OPENAI_PROCESSING_VERSION ||
        binding.nativeParameters?.serviceTier !== tier ||
        binding.nativeParameters?.speed !== null ||
        (tier !== "fast" && tier !== "default")
      ) {
        throw new Error("OpenAI processing admission is unavailable or stale.");
      }
      return tier;
    },
  };
}

/** Accept response objects and stream terminal tier fields, never arbitrary provider metadata. */
function openAiProcessingObservation(
  tier: unknown,
  request: ModelRequest,
  now: number,
  official: boolean,
): ProcessingObservation {
  const nativeTier =
    tier === "default" ||
    tier === "fast" ||
    tier === "priority" ||
    tier === "auto" ||
    tier === "flex"
      ? tier
      : null;
  let actualMode: ProcessingObservation["actualMode"] = "unknown";
  if (official) {
    if (nativeTier === "default") actualMode = "standard";
    if (nativeTier === "fast" || nativeTier === "priority") actualMode = "fast";
  }
  return {
    actualMode,
    nativeTier,
    source: "provider-final",
    observedAt: now,
    downgradeReason:
      request.processing?.resolvedMode === "fast" && actualMode === "standard" ? "unknown" : null,
    usageAttribution: actualMode === "unknown" ? "unknown" : "request",
  };
}
