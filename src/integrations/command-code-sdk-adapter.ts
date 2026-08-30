/** Command Code Provider API adapter with exact per-model protocol routing. */

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import {
  COMMAND_CODE_ANTHROPIC_BASE_URL,
  COMMAND_CODE_OPENAI_BASE_URL,
  COMMAND_CODE_PROVIDER_ID,
  commandCodeProtocolFor,
} from "../providers/command-code.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import type {
  CommandCodeTransportCompatibilityDeclaration,
  ProviderModelTransportCompatibilityOverride,
} from "../providers/transport-compatibility.ts";
import { createAnthropicSdkAdapter } from "./anthropic-sdk-adapter.ts";
import { createOpenAiSdkAdapter, type OpenAiSdkFetch } from "./openai-sdk-adapter.ts";
import { providerDestinationId } from "./provider-destination.ts";
import { resolveProviderTransportCompatibilityPlanSet } from "./provider-transport-compatibility.ts";

export type CommandCodeSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly supportedModels: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly fetch?: OpenAiSdkFetch;
  readonly compatibility?: CommandCodeTransportCompatibilityDeclaration;
  readonly modelCompatibility?: readonly ProviderModelTransportCompatibilityOverride[];
};

type CommandCodeChildAdapters = {
  readonly openai: ProviderAdapterPort;
  readonly anthropic: ProviderAdapterPort;
};

type CommandCodeChildAdapterFactory = (
  options: CommandCodeSdkAdapterOptions,
  supportedModels: Readonly<Record<"openai" | "anthropic", readonly string[]>>,
) => CommandCodeChildAdapters;

function supportedModelsByProtocol(models: readonly string[]): {
  readonly openai: readonly string[];
  readonly anthropic: readonly string[];
} {
  const openai: string[] = [];
  const anthropic: string[] = [];
  for (const model of models) {
    const protocol = commandCodeProtocolFor(model);
    if (protocol === "openai") {
      openai.push(model);
    } else if (protocol === "anthropic") {
      anthropic.push(model);
    }
  }
  return { openai, anthropic };
}

function defaultChildren(
  options: CommandCodeSdkAdapterOptions,
  supportedModels: Readonly<Record<"openai" | "anthropic", readonly string[]>>,
): CommandCodeChildAdapters {
  const common = {
    profileId: options.profileId,
    providerId: options.providerId ?? COMMAND_CODE_PROVIDER_ID,
    displayName: options.displayName ?? "Command Code",
    resolveApiKey: options.resolveApiKey,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  };
  return {
    openai: createOpenAiSdkAdapter({
      ...common,
      baseUrl: COMMAND_CODE_OPENAI_BASE_URL,
      supportedModels: supportedModels.openai,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    anthropic: createAnthropicSdkAdapter({
      ...common,
      baseUrl: COMMAND_CODE_ANTHROPIC_BASE_URL,
      supportedModels: supportedModels.anthropic,
    }),
  };
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
      failure: {
        kind: "unsupported-capability",
        message,
        retryable: false,
      },
    },
  ];
}

function withoutPromptCache({ promptCache: _promptCache, ...request }: ModelRequest): ModelRequest {
  return request;
}

/**
 * Create one Command Code provider while preserving the protocol required by
 * each model. Claude uses Anthropic Messages; all other verified models use
 * OpenAI Chat Completions.
 */
export function createCommandCodeSdkAdapter(
  options: CommandCodeSdkAdapterOptions,
  createChildren: CommandCodeChildAdapterFactory = defaultChildren,
): ProviderAdapterPort {
  const grouped = supportedModelsByProtocol(options.supportedModels);
  const supportedModels = [...grouped.openai, ...grouped.anthropic].map(modelId.from);
  const resolvedCompatibility = resolveProviderTransportCompatibilityPlanSet(
    "commandcode",
    options.compatibility,
    supportedModels,
    options.modelCompatibility,
  );
  if (!resolvedCompatibility.ok) {
    throw new Error("Command Code adapter received an incompatible transport declaration");
  }
  const transportCompatibility = resolvedCompatibility.value.destination;
  const compatibilityByModel = new Map(
    resolvedCompatibility.value.models.map((entry) => [String(entry.modelId), entry.plan]),
  );
  const children = createChildren(options, grouped);

  return {
    identity: {
      providerId: providerId.from(options.providerId ?? COMMAND_CODE_PROVIDER_ID),
      profileId: options.profileId,
      adapterKind: "commandcode",
      endpoint: COMMAND_CODE_OPENAI_BASE_URL,
      destinationId: providerDestinationId("commandcode", COMMAND_CODE_OPENAI_BASE_URL),
      transportCompatibilityId: transportCompatibility.compatibilityId,
      displayName: options.displayName ?? "Command Code",
    },
    supportedModels,
    // Both SDK leaves remain text-only until Falryn resolves image handles.
    requestInputModalities: ["text"],
    // OpenAI-compatible transport does not establish OpenAI-native verbosity support.
    requestResponseDensityControls: [],
    transportCompatibility,
    transportCompatibilityFor(selectedModelId) {
      return compatibilityByModel.get(String(selectedModelId)) ?? null;
    },
    async *stream(
      request: ModelRequest,
      streamOptions: ProviderStreamOptions,
    ): AsyncIterable<NormalizedProviderEvent> {
      const protocol = commandCodeProtocolFor(String(request.modelId));
      if (protocol === null) {
        yield* unsupportedEvents(
          request,
          "The selected Command Code model has no verified transport mapping.",
        );
        return;
      }
      if (request.responseDensityControl !== null && request.responseDensityControl !== undefined) {
        yield* unsupportedEvents(
          request,
          "Command Code does not publish a native response-density contract for this model.",
        );
        return;
      }
      if (request.promptCache !== undefined && request.promptCache.mode !== "provider-managed") {
        yield* unsupportedEvents(
          request,
          "The selected Command Code route received an incompatible prompt-cache mechanism.",
        );
        return;
      }
      // Command Code owns cache routing behind both wire protocols. Preserve
      // Falryn's byte-stable prefix, but do not leak OpenAI or Anthropic cache
      // controls into a provider-managed API contract.
      const delegated = request.promptCache === undefined ? request : withoutPromptCache(request);
      yield* children[protocol].stream(delegated, streamOptions);
    },
  };
}
