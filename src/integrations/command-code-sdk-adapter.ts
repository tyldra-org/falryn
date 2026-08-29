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
import { createAnthropicSdkAdapter } from "./anthropic-sdk-adapter.ts";
import { createOpenAiSdkAdapter, type OpenAiSdkFetch } from "./openai-sdk-adapter.ts";
import { providerDestinationId } from "./provider-destination.ts";

export type CommandCodeSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly supportedModels: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly fetch?: OpenAiSdkFetch;
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

function unsupportedModelEvents(request: ModelRequest): readonly NormalizedProviderEvent[] {
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
        message: "The selected Command Code model has no verified transport mapping.",
        retryable: false,
      },
    },
  ];
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
  const children = createChildren(options, grouped);
  const supportedModels = [...grouped.openai, ...grouped.anthropic].map(modelId.from);

  return {
    identity: {
      providerId: providerId.from(options.providerId ?? COMMAND_CODE_PROVIDER_ID),
      profileId: options.profileId,
      adapterKind: "commandcode",
      endpoint: COMMAND_CODE_OPENAI_BASE_URL,
      destinationId: providerDestinationId("commandcode", COMMAND_CODE_OPENAI_BASE_URL),
      displayName: options.displayName ?? "Command Code",
    },
    supportedModels,
    // Both SDK leaves remain text-only until Falryn resolves image handles.
    requestInputModalities: ["text"],
    async *stream(
      request: ModelRequest,
      streamOptions: ProviderStreamOptions,
    ): AsyncIterable<NormalizedProviderEvent> {
      const protocol = commandCodeProtocolFor(String(request.modelId));
      if (protocol === null) {
        yield* unsupportedModelEvents(request);
        return;
      }
      yield* children[protocol].stream(request, streamOptions);
    },
  };
}
