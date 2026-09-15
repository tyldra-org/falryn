/** A previously admitted binding for isolated adapter transport conformance tests. */
import type { ProcessingBinding } from "../../domain/sessions/model-processing.ts";
import type { ProviderAdapterPort } from "../../providers/protocol/port.ts";
import type { ModelRequest } from "../../providers/protocol/request.ts";

export function admittedOpenAiRequest(
  adapter: ProviderAdapterPort,
  request: ModelRequest,
  mode: "fast" | "standard",
): ModelRequest {
  const plan = adapter.transportCompatibilityFor(request.modelId);
  const qualification = plan?.declaration.processingQualifications?.find(
    (entry) => entry.modelId === request.modelId,
  );
  const authority = adapter.processingAuthority?.(request.modelId, mode);
  if (!plan || !qualification || !authority) throw new Error("Missing fixture qualification");
  const processing: ProcessingBinding = {
    schemaVersion: 1,
    providerId: adapter.identity.providerId,
    accountId: adapter.identity.profileId,
    destinationId: adapter.identity.destinationId,
    modelId: request.modelId,
    operation: plan.declaration.dialect,
    transportCompatibilityId: plan.compatibilityId,
    adapterGeneration: authority.adapterGeneration,
    accountGeneration: authority.accountGeneration,
    catalogGeneration: 1,
    configurationGeneration: 1,
    preference: { mode, fallback: "stop" },
    resolvedMode: mode,
    nativeParameters: qualification.modes[mode].nativeParameters,
    price: {
      sourceUrl: null,
      observedAt: null,
      tierIds: [],
      inputMicrosPerMillion: null,
      outputMicrosPerMillion: null,
    },
    maximumCostMicros: null,
    admission: { owner: "fixture", attempt: "fixture", operation: "fixture" },
    cachePartition: null,
  };
  return { ...request, processing };
}
