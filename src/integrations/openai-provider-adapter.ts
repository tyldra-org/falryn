/** OpenAI provider adapter with exact-model Chat Completions/Responses routing. */

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import type { ProviderContinuationStatePort } from "../providers/continuation-state.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import {
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  OPENAI_RESPONSES_TRANSPORT_DEFAULT,
  type OpenAiChatTransportCompatibilityDeclaration,
  type OpenAiResponsesTransportCompatibilityDeclaration,
  type ProviderModelTransportCompatibilityOverride,
  type ProviderTransportCompatibilityDeclaration,
} from "../providers/transport-compatibility.ts";
import { createOpenAiResponsesSdkAdapter } from "./openai-responses-sdk-adapter.ts";
import { createOpenAiSdkAdapter, type OpenAiSdkFetch } from "./openai-sdk-adapter.ts";
import { providerDestinationId } from "./provider-destination.ts";
import { resolveProviderTransportCompatibilityPlanSet } from "./provider-transport-compatibility.ts";

export type OpenAiProviderAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly baseUrl: string;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly fetch?: OpenAiSdkFetch;
  readonly supportedModels: readonly string[];
  readonly organization?: string | null;
  readonly project?: string | null;
  readonly requestTimeoutMs?: number;
  readonly compatibility:
    | OpenAiChatTransportCompatibilityDeclaration
    | OpenAiResponsesTransportCompatibilityDeclaration;
  readonly modelCompatibility?: readonly ProviderModelTransportCompatibilityOverride[];
  readonly continuationState?: ProviderContinuationStatePort;
  readonly now?: () => number;
};

type OpenAiTransport = "chat" | "responses";

function transportFor(
  declaration: ProviderTransportCompatibilityDeclaration,
): OpenAiTransport | null {
  if (declaration.dialect === "openai-chat-completions") {
    return "chat";
  }
  if (declaration.dialect === "openai-responses") {
    return "responses";
  }
  return null;
}

function unsupportedEvents(
  request: ModelRequest,
  message: string,
): readonly NormalizedProviderEvent[] {
  const attempt = modelAttemptId.from(`attempt-${request.requestId}`);
  return [
    {
      kind: "request-started",
      requestId: request.requestId,
      modelAttemptId: attempt,
      sequence: 1,
    },
    {
      kind: "error",
      requestId: request.requestId,
      modelAttemptId: attempt,
      sequence: 2,
      failure: { kind: "unsupported-capability", message, retryable: false },
    },
  ];
}

/**
 * Create one OpenAI provider while keeping SDK dialects as private leaves.
 * Each request is routed by its immutable exact-model compatibility plan.
 */
export function createOpenAiProviderAdapter(
  options: OpenAiProviderAdapterOptions,
): ProviderAdapterPort {
  const supportedModels = options.supportedModels.map(modelId.from);
  const resolved = resolveProviderTransportCompatibilityPlanSet(
    "openai",
    options.compatibility,
    supportedModels,
    options.modelCompatibility,
  );
  if (!resolved.ok) {
    throw new Error("OpenAI provider received an incompatible transport declaration");
  }

  const planByModel = new Map(
    resolved.value.models.map((entry) => [String(entry.modelId), entry.plan]),
  );
  const grouped: Record<OpenAiTransport, string[]> = { chat: [], responses: [] };
  for (const entry of resolved.value.models) {
    const transport = transportFor(entry.plan.declaration);
    if (transport !== null) {
      grouped[transport].push(String(entry.modelId));
    }
  }

  const common = {
    profileId: options.profileId,
    providerId: options.providerId ?? "openai",
    displayName: options.displayName ?? "OpenAI",
    baseUrl: options.baseUrl,
    resolveApiKey: options.resolveApiKey,
    organization: options.organization ?? null,
    project: options.project ?? null,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const chatOverrides = (options.modelCompatibility ?? []).filter(
    (entry) => entry.declaration.dialect === "openai-chat-completions",
  );
  const responsesOverrides = (options.modelCompatibility ?? []).filter(
    (entry) => entry.declaration.dialect === "openai-responses",
  );
  const chat = createOpenAiSdkAdapter({
    ...common,
    supportedModels: grouped.chat,
    compatibility:
      options.compatibility.dialect === "openai-chat-completions"
        ? options.compatibility
        : OPENAI_CHAT_TRANSPORT_DEFAULT,
    modelCompatibility: chatOverrides,
  });
  const responses = createOpenAiResponsesSdkAdapter({
    ...common,
    supportedModels: grouped.responses,
    compatibility:
      options.compatibility.dialect === "openai-responses"
        ? options.compatibility
        : OPENAI_RESPONSES_TRANSPORT_DEFAULT,
    modelCompatibility: responsesOverrides,
    ...(options.continuationState === undefined
      ? {}
      : { continuationState: options.continuationState }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const transportCompatibility = resolved.value.destination;

  return {
    identity: {
      providerId: providerId.from(options.providerId ?? "openai"),
      profileId: options.profileId,
      adapterKind: "openai",
      endpoint: options.baseUrl,
      destinationId: providerDestinationId("openai", options.baseUrl),
      transportCompatibilityId: transportCompatibility.compatibilityId,
      displayName: options.displayName ?? "OpenAI",
    },
    supportedModels,
    requestInputModalities: ["text"],
    requestResponseDensityControls: ["low", "medium", "high"],
    transportCompatibility,
    transportCompatibilityFor(selectedModelId) {
      return planByModel.get(String(selectedModelId)) ?? null;
    },
    async *stream(
      request: ModelRequest,
      streamOptions: ProviderStreamOptions,
    ): AsyncIterable<NormalizedProviderEvent> {
      const plan = planByModel.get(String(request.modelId));
      const transport = plan === undefined ? null : transportFor(plan.declaration);
      if (transport === null) {
        yield* unsupportedEvents(
          request,
          "The selected OpenAI model has no verified transport compatibility plan.",
        );
        return;
      }
      yield* (transport === "chat" ? chat : responses).stream(request, streamOptions);
    },
  };
}
