/**
 * Anthropic SDK Messages adapter.
 *
 * Falryn owns the provider-neutral request, event, policy, and retry contracts.
 * The official SDK owns authentication headers, HTTP execution, SSE decoding,
 * and endpoint transport inside this leaf adapter.
 */

import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  type ClientOptions,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  RedactedThinkingBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";

import { type ModelId, modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import {
  PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
  type ProviderContinuationStateKey,
  type ProviderContinuationStatePort,
} from "../providers/continuation-state.ts";
import type { ProviderFailure, ProviderFailureKind } from "../providers/errors.ts";
import type { ModelMessage, ModelToolDefinition } from "../providers/messages.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent, UsageUnits } from "../providers/stream.ts";
import type {
  AnthropicMessagesTransportCompatibilityDeclaration,
  ProviderModelTransportCompatibilityOverride,
  ProviderTransportCompatibilityPlan,
} from "../providers/transport-compatibility.ts";
import { providerDestinationId } from "./provider-destination.ts";
import { resolveProviderTransportCompatibilityPlanSet } from "./provider-transport-compatibility.ts";

export type AnthropicSdkFetch = NonNullable<ClientOptions["fetch"]>;

export type AnthropicSdkStreamFactory = (
  apiKey: string,
  body: MessageCreateParamsStreaming,
  signal: AbortSignal,
) => Promise<AsyncIterable<RawMessageStreamEvent>>;

export type AnthropicSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly baseUrl?: string | null;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly fetch?: AnthropicSdkFetch;
  readonly supportedModels: readonly string[];
  readonly requestTimeoutMs?: number;
  /** Deterministic SDK boundary used by tests. Production leaves this absent. */
  readonly createStream?: AnthropicSdkStreamFactory;
  readonly compatibility?: AnthropicMessagesTransportCompatibilityDeclaration;
  readonly modelCompatibility?: readonly ProviderModelTransportCompatibilityOverride[];
  readonly continuationState?: ProviderContinuationStatePort;
  /** Injectable for deterministic persistence fixtures. */
  readonly now?: () => number;
};

type ToolCallState = {
  readonly id: string;
  readonly name: string;
  arguments: string;
  proposed: boolean;
  stopped: boolean;
};

type RetainedThinkingBlock = ThinkingBlockParam | RedactedThinkingBlockParam;

type RetainedContinuation = {
  readonly thinking: readonly RetainedThinkingBlock[];
};

type ContentBlockState =
  | { readonly type: "text"; stopped: boolean }
  | { readonly type: "thinking"; thinking: string; signature: string; stopped: boolean }
  | { readonly type: "redacted-thinking"; readonly data: string; stopped: boolean }
  | ({ readonly type: "tool" } & ToolCallState);

const MAX_RETAINED_TOOL_CALLS = 256;
const MAX_RETAINED_THINKING_BLOCKS = 64;
const MAX_CONTINUATION_STATE_JSON_LENGTH = 4 * 1024 * 1024;

class AnthropicInputError extends Error {
  readonly failureKind: ProviderFailureKind;

  constructor(failureKind: ProviderFailureKind, message: string) {
    super(message);
    this.name = "AnthropicInputError";
    this.failureKind = failureKind;
  }
}

function failure(
  kind: ProviderFailureKind,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): ProviderFailure {
  return {
    kind,
    message,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function retryAfterMs(headers: Headers): number | undefined {
  const millisecondsHeader = headers.get("retry-after-ms");
  const milliseconds = millisecondsHeader === null ? Number.NaN : Number(millisecondsHeader);
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    return Math.trunc(milliseconds);
  }
  const secondsHeader = headers.get("retry-after");
  const seconds = secondsHeader === null ? Number.NaN : Number(secondsHeader);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1_000) : undefined;
}

function textOf(message: ModelMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function rejectImageParts(messages: readonly ModelMessage[]): void {
  if (messages.some((message) => message.parts.some((part) => part.kind === "image"))) {
    throw new AnthropicInputError(
      "unsupported-capability",
      "The Anthropic adapter cannot resolve image handles in this request.",
    );
  }
}

function anthropicReasoningEffort(
  control: string | null | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  switch (control) {
    case undefined:
    case null:
      return undefined;
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return control;
    default:
      throw new AnthropicInputError(
        "unsupported-capability",
        "The selected Anthropic model does not support the requested reasoning control.",
      );
  }
}

function assistantToolCallIds(messages: readonly ModelMessage[]): readonly string[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.toolCallId) : [],
  );
}

function retainedThinkingFor(
  message: ModelMessage,
  compatibility: AnthropicMessagesTransportCompatibilityDeclaration,
  retained: ReadonlyMap<string, RetainedContinuation>,
): readonly RetainedThinkingBlock[] {
  if (compatibility.thinkingReplay === "none") {
    return [];
  }
  const records = (message.toolCalls ?? [])
    .map((call) => retained.get(call.toolCallId))
    .filter((record): record is RetainedContinuation => record !== undefined);
  if (records.length === 0) {
    return [];
  }
  const canonical = JSON.stringify(records[0]);
  if (records.some((record) => JSON.stringify(record) !== canonical)) {
    throw new AnthropicInputError(
      "invalid-request",
      "Anthropic tool calls refer to conflicting retained thinking state.",
    );
  }
  return records[0]?.thinking ?? [];
}

function toAnthropicMessages(
  messages: readonly ModelMessage[],
  promptCache: ModelRequest["promptCache"],
  compatibility: AnthropicMessagesTransportCompatibilityDeclaration,
  retained: ReadonlyMap<string, RetainedContinuation>,
): {
  readonly system: string | TextBlockParam[] | undefined;
  readonly messages: MessageParam[];
} {
  rejectImageParts(messages);
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystem < 0) {
    throw new AnthropicInputError(
      "invalid-request",
      "Anthropic Messages requires at least one non-system message.",
    );
  }
  if (messages.slice(firstNonSystem + 1).some((message) => message.role === "system")) {
    throw new AnthropicInputError(
      "invalid-request",
      "Anthropic system messages must form one leading prefix.",
    );
  }
  if (
    promptCache !== undefined &&
    promptCache.mode === "anthropic-ephemeral" &&
    (promptCache.stableMessageCount < 1 ||
      promptCache.stableMessageCount > messages.length ||
      messages
        .slice(0, promptCache.stableMessageCount)
        .some((message) => message.role !== "system" || textOf(message).length === 0))
  ) {
    throw new AnthropicInputError(
      "invalid-request",
      "The prompt cache boundary does not identify a stable system-message prefix.",
    );
  }
  const systemMessages = messages
    .map((message, index) => ({ message, index, text: textOf(message) }))
    .filter((entry) => entry.message.role === "system" && entry.text.length > 0);
  const system = systemMessages.map<TextBlockParam>((entry) => ({
    type: "text",
    text: entry.text,
    ...(promptCache?.mode === "anthropic-ephemeral" &&
    entry.index === promptCache.stableMessageCount - 1
      ? {
          cache_control: {
            type: "ephemeral",
            ttl: compatibility.promptCacheTtl ?? "5m",
          },
        }
      : {}),
  }));
  const translated: MessageParam[] = [];
  const pendingToolCalls = new Set<string>();
  const seenToolCalls = new Set<string>();
  let pendingToolResults: ContentBlockParam[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) {
      return;
    }
    if (pendingToolCalls.size > 0) {
      throw new AnthropicInputError(
        "invalid-request",
        "An Anthropic assistant tool turn is missing one or more tool results.",
      );
    }
    translated.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new AnthropicInputError(
          "invalid-request",
          "An Anthropic tool result requires a matching tool call identity.",
        );
      }
      if (!pendingToolCalls.delete(message.toolCallId)) {
        throw new AnthropicInputError(
          "invalid-request",
          "An Anthropic tool result has no unmatched assistant tool call.",
        );
      }
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: textOf(message),
      });
      continue;
    }
    flushToolResults();
    if (message.role === "assistant") {
      const content: ContentBlockParam[] = [];
      content.push(...retainedThinkingFor(message, compatibility, retained));
      const text = textOf(message);
      if (text.length > 0) {
        content.push({ type: "text", text });
      }
      for (const call of message.toolCalls ?? []) {
        if (seenToolCalls.has(call.toolCallId)) {
          throw new AnthropicInputError(
            "invalid-request",
            "An Anthropic assistant message contains a duplicate tool call identity.",
          );
        }
        seenToolCalls.add(call.toolCallId);
        pendingToolCalls.add(call.toolCallId);
        content.push({
          type: "tool_use",
          id: call.toolCallId,
          name: call.name,
          input: call.arguments,
        });
      }
      if (content.length > 0) {
        translated.push({ role: "assistant", content });
      }
      continue;
    }
    const text = textOf(message);
    if (text.length > 0) {
      translated.push({ role: "user", content: text });
    }
  }

  flushToolResults();
  if (pendingToolCalls.size > 0) {
    throw new AnthropicInputError(
      "invalid-request",
      "An Anthropic assistant tool turn is missing one or more tool results.",
    );
  }

  return { system: system.length === 0 ? undefined : system, messages: translated };
}

function toTools(
  tools: readonly ModelToolDefinition[],
  compatibility: AnthropicMessagesTransportCompatibilityDeclaration,
): Tool[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.parameters, type: "object" },
    strict: compatibility.strictToolSchemas,
  }));
}

function classifySdkError(error: unknown, signal: AbortSignal): ProviderFailure {
  if (signal.aborted || error instanceof APIUserAbortError) {
    return failure("cancellation", "The provider request was cancelled.", false);
  }
  if (error instanceof AnthropicInputError) {
    return failure(error.failureKind, error.message, false);
  }
  if (error instanceof APIConnectionTimeoutError) {
    return failure("timeout", "The provider request timed out.", true);
  }
  if (error instanceof AuthenticationError) {
    return failure("authentication", "The provider rejected the credentials.", false);
  }
  if (error instanceof PermissionDeniedError) {
    return failure("authorization", "The provider denied this request.", false);
  }
  if (error instanceof RateLimitError) {
    return failure(
      "rate-limit",
      "The provider rate-limited this request.",
      true,
      retryAfterMs(error.headers),
    );
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return failure("invalid-request", "The provider rejected the request shape.", false);
  }
  if (error instanceof InternalServerError) {
    return failure("server-failure", "The provider returned a server failure.", true);
  }
  if (error instanceof APIConnectionError) {
    return failure("network", "The provider network request failed.", true);
  }
  if (error instanceof SyntaxError) {
    return failure("malformed-stream", "The provider stream contained invalid JSON.", false);
  }
  if (error instanceof APIError) {
    return failure("server-failure", "The provider returned an unexpected failure.", true);
  }
  return failure("adapter-defect", "The Anthropic SDK adapter failed unexpectedly.", false);
}

function clientFor(options: AnthropicSdkAdapterOptions, apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    baseURL: options.baseUrl?.replace(/\/+$/u, "") ?? null,
    maxRetries: 0,
    timeout: options.requestTimeoutMs ?? 120_000,
    logLevel: "off",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function streamFor(
  options: AnthropicSdkAdapterOptions,
  apiKey: string,
  body: MessageCreateParamsStreaming,
  signal: AbortSignal,
): Promise<AsyncIterable<RawMessageStreamEvent>> {
  if (options.createStream !== undefined) {
    return options.createStream(apiKey, body, signal);
  }
  return clientFor(options, apiKey).messages.create(body, { signal });
}

function usageFrom(
  input: {
    readonly inputTokens: number;
    readonly cacheCreationTokens: number;
    readonly cacheReadTokens: number;
  },
  outputTokens: number,
  reasoningTokens?: number,
): UsageUnits {
  const totalInputTokens = input.inputTokens + input.cacheCreationTokens + input.cacheReadTokens;
  return {
    provenance: "provider-reported",
    inputTokens: totalInputTokens,
    outputTokens,
    totalTokens: totalInputTokens + outputTokens,
    cachedInputTokens: input.cacheReadTokens,
    cacheWriteInputTokens: input.cacheCreationTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseRetainedContinuation(stateJson: string): RetainedContinuation | null {
  if (stateJson.length === 0 || stateJson.length > MAX_CONTINUATION_STATE_JSON_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson) as unknown;
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !hasOnlyKeys(parsed, ["thinking"]) ||
    !("thinking" in parsed) ||
    !Array.isArray(parsed.thinking) ||
    parsed.thinking.length > MAX_RETAINED_THINKING_BLOCKS
  ) {
    return null;
  }
  const thinking: RetainedThinkingBlock[] = [];
  for (const block of parsed.thinking) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      return null;
    }
    if (
      block.type === "thinking" &&
      "thinking" in block &&
      typeof block.thinking === "string" &&
      "signature" in block &&
      typeof block.signature === "string" &&
      block.signature.length > 0 &&
      hasOnlyKeys(block, ["type", "thinking", "signature"])
    ) {
      thinking.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      continue;
    }
    if (
      block.type === "redacted_thinking" &&
      "data" in block &&
      typeof block.data === "string" &&
      block.data.length > 0 &&
      hasOnlyKeys(block, ["type", "data"])
    ) {
      thinking.push({ type: "redacted_thinking", data: block.data });
      continue;
    }
    return null;
  }
  return { thinking };
}

function continuationStateJson(value: RetainedContinuation): string {
  return JSON.stringify({ thinking: value.thinking });
}

function retain(
  retained: Map<string, RetainedContinuation>,
  toolCallId: string,
  value: RetainedContinuation,
): void {
  retained.delete(toolCallId);
  retained.set(toolCallId, value);
  while (retained.size > MAX_RETAINED_TOOL_CALLS) {
    const oldest = retained.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    retained.delete(oldest);
  }
}

/** Create a live SDK-backed Anthropic Messages adapter. */
export function createAnthropicSdkAdapter(
  options: AnthropicSdkAdapterOptions,
): ProviderAdapterPort {
  const models = options.supportedModels.map((id) => modelId.from(id));
  const resolvedCompatibility = resolveProviderTransportCompatibilityPlanSet(
    "anthropic",
    options.compatibility,
    models,
    options.modelCompatibility,
  );
  if (!resolvedCompatibility.ok) {
    throw new Error("Anthropic SDK adapter received an incompatible transport declaration");
  }
  const transportCompatibility = resolvedCompatibility.value.destination;
  if (transportCompatibility.declaration.dialect !== "anthropic-messages") {
    throw new Error("Anthropic SDK adapter requires the Messages dialect");
  }
  const compatibilityByModel = new Map(
    resolvedCompatibility.value.models.map((entry) => [String(entry.modelId), entry.plan]),
  );
  const retained = new Map<string, RetainedContinuation>();
  const transportCompatibilityFor = (
    selectedModelId: ModelId,
  ): ProviderTransportCompatibilityPlan | null =>
    compatibilityByModel.get(String(selectedModelId)) ?? null;
  const identity = {
    providerId: providerId.from(options.providerId ?? "anthropic"),
    profileId: options.profileId,
    adapterKind: "anthropic" as const,
    endpoint: options.baseUrl ?? null,
    destinationId: providerDestinationId("anthropic", options.baseUrl ?? null),
    transportCompatibilityId: transportCompatibility.compatibilityId,
    displayName: options.displayName ?? "Anthropic",
  };
  const continuationKey = (
    selectedModelId: ModelId,
    transportCompatibilityId: string,
    toolCallId: string,
  ): ProviderContinuationStateKey => ({
    profileId: identity.profileId,
    providerId: identity.providerId,
    destinationId: identity.destinationId,
    transportCompatibilityId,
    modelId: selectedModelId,
    toolCallId,
  });

  return {
    identity,
    supportedModels: models,
    requestInputModalities: ["text"],
    requestResponseDensityControls: [],
    transportCompatibility,
    transportCompatibilityFor,
    async *stream(
      request: ModelRequest,
      streamOptions: ProviderStreamOptions,
    ): AsyncIterable<NormalizedProviderEvent> {
      const attempt = modelAttemptId.from(`attempt-${request.requestId}`);
      let sequence = 1;
      const next = (): number => sequence++;
      const errorEvent = (providerFailure: ProviderFailure): NormalizedProviderEvent => ({
        kind: "error",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: next(),
        failure: providerFailure,
      });

      yield {
        kind: "request-started",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: next(),
      };

      if (streamOptions.signal.aborted) {
        yield errorEvent(failure("cancellation", "The provider request was cancelled.", false));
        return;
      }

      const plan = transportCompatibilityFor(request.modelId);
      if (plan === null || plan.declaration.dialect !== "anthropic-messages") {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "The selected model has no verified Anthropic Messages transport plan.",
            false,
          ),
        );
        return;
      }
      if (
        request.metadata.transportCompatibilityId !== undefined &&
        request.metadata.transportCompatibilityId !== plan.compatibilityId
      ) {
        yield errorEvent(
          failure(
            "invalid-request",
            "The request transport identity does not match the Anthropic Messages plan.",
            false,
          ),
        );
        return;
      }
      const compatibility = plan.declaration;
      if (request.responseDensityControl !== null && request.responseDensityControl !== undefined) {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "This Anthropic SDK route has no verified native response-density control.",
            false,
          ),
        );
        return;
      }
      if (request.promptCache !== undefined && request.promptCache.mode !== "anthropic-ephemeral") {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "The routed prompt-cache mechanism is incompatible with Anthropic.",
            false,
          ),
        );
        return;
      }
      if (request.promptCache !== undefined && compatibility.promptCachePlacement === "none") {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "This Anthropic Messages plan does not permit prompt caching.",
            false,
          ),
        );
        return;
      }
      if (
        request.output.kind === "json-schema" &&
        compatibility.structuredOutput !== "output-config-json-schema"
      ) {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "This Anthropic Messages plan does not permit structured output.",
            false,
          ),
        );
        return;
      }
      if (
        request.reasoningControl !== null &&
        request.reasoningControl !== undefined &&
        compatibility.thinking === "none"
      ) {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "This Anthropic Messages plan does not permit adaptive thinking.",
            false,
          ),
        );
        return;
      }

      const retainedForRequest = new Map(retained);
      let durableStateLoaded = 0;
      if (options.continuationState !== undefined) {
        for (const toolCallId of assistantToolCallIds(request.messages)) {
          if (retainedForRequest.has(toolCallId)) {
            continue;
          }
          const loaded = options.continuationState.load(
            continuationKey(request.modelId, plan.compatibilityId, toolCallId),
          );
          if (!loaded.ok) {
            yield errorEvent(
              failure(
                "adapter-defect",
                "Durable Anthropic continuation state could not be read.",
                false,
              ),
            );
            return;
          }
          if (loaded.value === null) {
            yield errorEvent(
              failure(
                "adapter-defect",
                "Required durable Anthropic continuation state is unavailable.",
                false,
              ),
            );
            return;
          }
          const parsed = parseRetainedContinuation(loaded.value.stateJson);
          if (parsed === null) {
            yield errorEvent(
              failure(
                "adapter-defect",
                "Durable Anthropic continuation state is malformed.",
                false,
              ),
            );
            return;
          }
          retain(retainedForRequest, toolCallId, parsed);
          retain(retained, toolCallId, parsed);
          durableStateLoaded += 1;
        }
      }
      if (durableStateLoaded > 0) {
        yield {
          kind: "provider-metadata",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          entries: {
            continuationStateLoaded: "true",
            continuationStateLoadedCount: String(durableStateLoaded),
          },
        };
      }

      let apiKey: string | null;
      try {
        apiKey = await options.resolveApiKey(streamOptions.signal);
      } catch (error) {
        yield errorEvent(classifySdkError(error, streamOptions.signal));
        return;
      }
      if (apiKey === null || apiKey.trim() === "") {
        yield errorEvent(
          failure("authentication", "No provider credential is available for this profile.", false),
        );
        return;
      }

      let body: MessageCreateParamsStreaming;
      try {
        const translated = toAnthropicMessages(
          request.messages,
          request.promptCache,
          compatibility,
          retainedForRequest,
        );
        const tools = toTools(request.tools, compatibility);
        const reasoningEffort = anthropicReasoningEffort(request.reasoningControl);
        const outputConfig = {
          ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
          ...(request.output.kind === "json-schema"
            ? { format: { type: "json_schema" as const, schema: request.output.schema } }
            : {}),
        };
        body = {
          model: String(request.modelId),
          stream: true,
          max_tokens: request.budgets.maxOutputTokens ?? 4_096,
          messages: translated.messages,
          ...(translated.system === undefined ? {} : { system: translated.system }),
          ...(tools === undefined ? {} : { tools }),
          ...(reasoningEffort === undefined || compatibility.thinking === "none"
            ? {}
            : { thinking: { type: "adaptive" as const } }),
          ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
          service_tier: compatibility.serviceTier,
        };
      } catch (error) {
        yield errorEvent(classifySdkError(error, streamOptions.signal));
        return;
      }

      const contentBlocks = new Map<number, ContentBlockState>();
      const toolCallIds = new Set<string>();
      const thinking: RetainedThinkingBlock[] = [];
      let finishReason: string | null = null;
      let inputUsage = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      let finalUsage: UsageUnits | null = null;
      let messageStartSeen = false;
      let messageDeltaSeen = false;
      let messageStopSeen = false;

      try {
        const stream = await streamFor(options, apiKey, body, streamOptions.signal);
        for await (const event of stream) {
          if (messageStopSeen) {
            throw new AnthropicInputError(
              "malformed-stream",
              "The Anthropic stream emitted data after message_stop.",
            );
          }
          switch (event.type) {
            case "message_start": {
              if (messageStartSeen || messageDeltaSeen || contentBlocks.size > 0) {
                throw new AnthropicInputError(
                  "malformed-stream",
                  "The Anthropic stream emitted a duplicate or out-of-order message_start.",
                );
              }
              messageStartSeen = true;
              const usage = event.message.usage;
              inputUsage = {
                inputTokens: usage.input_tokens,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              };
              break;
            }
            case "content_block_start": {
              if (!messageStartSeen || messageDeltaSeen || contentBlocks.has(event.index)) {
                throw new AnthropicInputError(
                  "malformed-stream",
                  "The Anthropic stream emitted an out-of-order or duplicate content block.",
                );
              }
              const block = event.content_block;
              if (block.type === "text") {
                contentBlocks.set(event.index, { type: "text", stopped: false });
                if (block.text.length > 0) {
                  yield {
                    kind: "text-delta",
                    requestId: request.requestId,
                    modelAttemptId: attempt,
                    sequence: next(),
                    text: block.text,
                  };
                }
              } else if (block.type === "thinking") {
                contentBlocks.set(event.index, {
                  type: "thinking",
                  thinking: block.thinking,
                  signature: block.signature,
                  stopped: false,
                });
                if (block.thinking.length > 0) {
                  yield {
                    kind: "reasoning-delta",
                    requestId: request.requestId,
                    modelAttemptId: attempt,
                    sequence: next(),
                    text: block.thinking,
                  };
                }
              } else if (block.type === "redacted_thinking") {
                contentBlocks.set(event.index, {
                  type: "redacted-thinking",
                  data: block.data,
                  stopped: false,
                });
              } else if (block.type === "tool_use") {
                if (block.id.length === 0 || block.name.length === 0 || toolCallIds.has(block.id)) {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream emitted malformed or duplicate tool-call identity.",
                  );
                }
                toolCallIds.add(block.id);
                const initial = JSON.stringify(block.input);
                contentBlocks.set(event.index, {
                  type: "tool",
                  id: block.id,
                  name: block.name,
                  arguments: initial === "{}" ? "" : initial,
                  proposed: false,
                  stopped: false,
                });
              } else {
                throw new AnthropicInputError(
                  "unsupported-capability",
                  "The Anthropic stream returned a server-side content block Falryn did not request.",
                );
              }
              break;
            }
            case "content_block_delta": {
              if (!messageStartSeen || messageDeltaSeen) {
                throw new AnthropicInputError(
                  "malformed-stream",
                  "The Anthropic stream emitted an out-of-order content delta.",
                );
              }
              const block = contentBlocks.get(event.index);
              if (block === undefined || block.stopped) {
                throw new AnthropicInputError(
                  "malformed-stream",
                  "The Anthropic stream emitted a delta for an inactive content block.",
                );
              }
              if (event.delta.type === "text_delta") {
                if (block.type !== "text") {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream attached text to the wrong content block.",
                  );
                }
                if (event.delta.text.length === 0) {
                  break;
                }
                yield {
                  kind: "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: event.delta.text,
                };
              } else if (event.delta.type === "thinking_delta") {
                if (block.type !== "thinking") {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream attached reasoning to the wrong content block.",
                  );
                }
                block.thinking += event.delta.thinking;
                if (event.delta.thinking.length === 0) {
                  break;
                }
                yield {
                  kind: "reasoning-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: event.delta.thinking,
                };
              } else if (event.delta.type === "signature_delta") {
                if (block.type !== "thinking" || block.signature.length > 0) {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream emitted an invalid thinking signature.",
                  );
                }
                block.signature = event.delta.signature;
              } else if (event.delta.type === "input_json_delta") {
                if (block.type !== "tool") {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream emitted tool arguments before a tool call.",
                  );
                }
                block.arguments += event.delta.partial_json;
                if (event.delta.partial_json.length === 0) {
                  break;
                }
                yield {
                  kind: "tool-call-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  toolCallId: block.id,
                  name: block.name,
                  argumentsFragment: event.delta.partial_json,
                };
              } else {
                throw new AnthropicInputError(
                  "unsupported-capability",
                  "The Anthropic stream returned citation data Falryn did not request.",
                );
              }
              break;
            }
            case "content_block_stop": {
              const block = contentBlocks.get(event.index);
              if (block === undefined || block.stopped || messageDeltaSeen) {
                throw new AnthropicInputError(
                  "malformed-stream",
                  "The Anthropic stream emitted an invalid content block stop.",
                );
              }
              block.stopped = true;
              if (block.type === "thinking") {
                if (block.signature.length === 0) {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream ended a thinking block without its signature.",
                  );
                }
                thinking.push({
                  type: "thinking",
                  thinking: block.thinking,
                  signature: block.signature,
                });
              } else if (block.type === "redacted-thinking") {
                if (block.data.length === 0) {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream returned an empty redacted-thinking block.",
                  );
                }
                thinking.push({ type: "redacted_thinking", data: block.data });
              } else if (block.type === "tool") {
                const argumentsJson = block.arguments.length === 0 ? "{}" : block.arguments;
                let parsedArguments: unknown;
                try {
                  parsedArguments = JSON.parse(argumentsJson) as unknown;
                } catch {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream ended a tool call with invalid JSON arguments.",
                  );
                }
                if (
                  typeof parsedArguments !== "object" ||
                  parsedArguments === null ||
                  Array.isArray(parsedArguments)
                ) {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream ended a tool call with non-object arguments.",
                  );
                }
                yield {
                  kind: "tool-proposal",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  toolCallId: block.id,
                  name: block.name,
                  argumentsJson,
                };
                block.proposed = true;
              }
              break;
            }
            case "message_delta": {
              if (
                !messageStartSeen ||
                messageDeltaSeen ||
                [...contentBlocks.values()].some((block) => !block.stopped) ||
                event.delta.stop_reason === null
              ) {
                throw new AnthropicInputError(
                  "malformed-stream",
                  "The Anthropic stream emitted an incomplete or out-of-order message delta.",
                );
              }
              messageDeltaSeen = true;
              finishReason = event.delta.stop_reason;
              inputUsage = {
                inputTokens: event.usage.input_tokens ?? inputUsage.inputTokens,
                cacheCreationTokens:
                  event.usage.cache_creation_input_tokens ?? inputUsage.cacheCreationTokens,
                cacheReadTokens: event.usage.cache_read_input_tokens ?? inputUsage.cacheReadTokens,
              };
              finalUsage = usageFrom(
                inputUsage,
                event.usage.output_tokens,
                event.usage.output_tokens_details?.thinking_tokens,
              );
              break;
            }
            case "message_stop": {
              if (!messageDeltaSeen || messageStopSeen) {
                throw new AnthropicInputError(
                  "malformed-stream",
                  "The Anthropic stream emitted an out-of-order or duplicate message_stop.",
                );
              }
              messageStopSeen = true;
              break;
            }
            default: {
              const exhaustive: never = event;
              throw new Error(`Unhandled Anthropic stream event: ${String(exhaustive)}`);
            }
          }
        }
      } catch (error) {
        yield errorEvent(classifySdkError(error, streamOptions.signal));
        return;
      }

      if (streamOptions.signal.aborted) {
        yield errorEvent(failure("cancellation", "The provider request was cancelled.", false));
        return;
      }
      if (!messageStartSeen || !messageDeltaSeen || !messageStopSeen || finishReason === null) {
        yield errorEvent(
          failure(
            "malformed-stream",
            "The provider stream ended without a complete terminal sequence.",
            false,
          ),
        );
        return;
      }
      if (finalUsage !== null) {
        yield {
          kind: "usage",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          usage: finalUsage,
        };
      }
      if (finishReason === "refusal") {
        yield errorEvent(failure("provider-safety", "The provider refused this request.", false));
        return;
      }
      if (finishReason === "pause_turn") {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "The provider paused this turn, but this route cannot yet replay the complete response.",
            false,
          ),
        );
        return;
      }
      if (finishReason === "model_context_window_exceeded") {
        yield errorEvent(
          failure("invalid-request", "The provider context window was exceeded.", false),
        );
        return;
      }

      const proposed = [...contentBlocks.values()].filter(
        (block): block is Extract<ContentBlockState, { readonly type: "tool" }> =>
          block.type === "tool" && block.proposed,
      );
      if (
        (finishReason === "tool_use" && proposed.length === 0) ||
        (finishReason !== "tool_use" && proposed.length > 0)
      ) {
        yield errorEvent(
          failure(
            "malformed-stream",
            "The Anthropic terminal reason does not match its tool-call output.",
            false,
          ),
        );
        return;
      }
      const retainedValue: RetainedContinuation = { thinking };
      if (proposed.length > 0 && options.continuationState !== undefined) {
        const stateJson = continuationStateJson(retainedValue);
        if (stateJson.length > MAX_CONTINUATION_STATE_JSON_LENGTH) {
          yield errorEvent(
            failure(
              "unsupported-capability",
              "Provider continuation state exceeds Falryn's durable bound.",
              false,
            ),
          );
          return;
        }
        const capturedAt = Math.max(0, Math.trunc(options.now?.() ?? Date.now()));
        const saved = options.continuationState.save(
          proposed.map((block) => ({
            ...continuationKey(request.modelId, plan.compatibilityId, block.id),
            schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
            stateJson,
            capturedAt,
          })),
        );
        if (!saved.ok) {
          yield errorEvent(
            failure(
              "adapter-defect",
              "Durable Anthropic continuation state could not be retained.",
              false,
            ),
          );
          return;
        }
        yield {
          kind: "provider-metadata",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          entries: {
            continuationStateSaved: "true",
            continuationStateSavedCount: String(proposed.length),
          },
        };
      }
      for (const block of proposed) {
        retain(retained, block.id, retainedValue);
      }
      yield {
        kind: "finished",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: next(),
        finishReason,
      };
    },
  };
}
