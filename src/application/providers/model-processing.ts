/** Pure processing inspection and immutable admission binding for model-service consumers. */
import {
  type ProcessingBinding,
  type ProcessingPreference,
  processingBindingSchema,
  resolveProcessingPreference,
} from "../../domain/sessions/model-processing.ts";
import { type ModelPricing, processingPrice } from "../../providers/catalog/model-pricing.ts";
import type { ProviderAdapterPort } from "../../providers/protocol/port.ts";
import type { RoutingReceipt } from "../../providers/routing/routing.ts";
import { processingCostMaximum } from "../runtime/provider-resource-admission.ts";

export function inspectModelProcessing(input: {
  readonly adapter: ProviderAdapterPort;
  readonly route: RoutingReceipt;
  readonly preference?: ProcessingPreference;
  readonly pricing?: ModelPricing;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}) {
  const { adapter, route } = input;
  const preference = resolveProcessingPreference([input.preference, route.processing]);
  const plan = adapter.transportCompatibilityFor(route.modelId);
  const qualification = plan?.declaration.processingQualifications?.find(
    (entry) =>
      entry.providerId === route.providerId &&
      entry.destinationId === route.providerDestinationId &&
      entry.modelId === route.modelId &&
      entry.operation === plan.declaration.dialect,
  );
  const mode = qualification?.modes[preference.mode];
  const authority = adapter.processingAuthority?.(route.modelId, preference.mode) ?? null;
  const reason =
    preference.mode === "provider-default"
      ? null
      : mode?.support !== "supported"
        ? `processing-${mode?.support ?? "unknown"}`
        : !adapter.processingModes?.includes(preference.mode) ||
            adapter.processingTransportVersion !== qualification?.transportVersion ||
            mode.nativeParameters === null
          ? "processing-integration-unavailable"
          : authority === null
            ? "processing-authority-unknown"
            : !authority.authorized
              ? "processing-unauthorized"
              : authority.capacity === "unavailable"
                ? "processing-capacity-unavailable"
                : null;
  const price = processingPrice(input.pricing, mode?.priceTierIds ?? null);
  return {
    operation: plan?.declaration.dialect ?? "unavailable",
    eligible: reason === null,
    reason,
    preference,
    qualification: qualification ?? null,
    authority,
    resolvedMode: preference.mode,
    nativeParameters:
      preference.mode === "provider-default" ? null : (mode?.nativeParameters ?? null),
    price,
    settlementPrices: {
      standard: processingPrice(input.pricing, qualification?.modes.standard.priceTierIds ?? null),
      fast: processingPrice(input.pricing, qualification?.modes.fast.priceTierIds ?? null),
    },
    maximumCostMicros: processingCostMaximum(price, input.inputTokens, input.outputTokens),
    /** The retry owner must admit a separate attempt; inspection never falls back. */
    standardFallbackAllowed: preference.mode === "fast" && preference.fallback === "allow-standard",
  };
}

export function bindModelProcessing(
  inspection: ReturnType<typeof inspectModelProcessing>,
  route: RoutingReceipt,
  configurationGeneration: number,
  admission: ProcessingBinding["admission"],
): ProcessingBinding {
  return freezeProcessing(
    processingBindingSchema.parse({
      schemaVersion: 1,
      providerId: route.providerId,
      accountId: route.providerProfileId,
      destinationId: route.providerDestinationId,
      modelId: route.modelId,
      operation: inspection.operation,
      transportCompatibilityId: route.transportCompatibilityId,
      adapterGeneration: inspection.authority?.adapterGeneration ?? null,
      accountGeneration: inspection.authority?.accountGeneration ?? null,
      catalogGeneration: route.catalogGeneration,
      configurationGeneration,
      preference: inspection.preference,
      resolvedMode: inspection.resolvedMode,
      nativeParameters: inspection.nativeParameters,
      price: inspection.price,
      maximumCostMicros: inspection.maximumCostMicros,
      admission,
      cachePartition:
        inspection.qualification?.cachePartitionByMode === true ? inspection.resolvedMode : null,
    }),
  );
}

/** Only local authority can change while an admitted request waits. Settings stay captured. */
export function processingAuthorityCurrent(
  adapter: ProviderAdapterPort,
  binding: ProcessingBinding,
): boolean {
  if (
    adapter.identity.providerId !== binding.providerId ||
    adapter.identity.profileId !== binding.accountId ||
    adapter.identity.destinationId !== binding.destinationId ||
    !adapter.supportedModels.some((model) => model === binding.modelId)
  )
    return false;
  const model = adapter.supportedModels.find((candidate) => candidate === binding.modelId);
  if (
    model === undefined ||
    adapter.transportCompatibilityFor(model)?.compatibilityId !== binding.transportCompatibilityId
  )
    return false;
  const current = adapter.processingAuthority?.(model, binding.resolvedMode);
  if (binding.accountGeneration === null) return current === undefined;
  return (
    current?.authorized === true &&
    current.accountGeneration === binding.accountGeneration &&
    current.adapterGeneration === binding.adapterGeneration &&
    current.capacity !== "unavailable"
  );
}

function freezeProcessing<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeProcessing(child);
    Object.freeze(value);
  }
  return value;
}
