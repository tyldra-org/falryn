/** Official OpenAI SDK adapter for the Responses transport. */

import OpenAI, {
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
} from "openai";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseReasoningItem,
  ResponseUsage,
} from "openai/resources/responses/responses";

import { type ModelId, modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import {
  PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
  type ProviderContinuationStateKey,
  type ProviderContinuationStatePort,
} from "../providers/continuation-state.ts";
import type { ProviderFailure, ProviderFailureKind } from "../providers/errors.ts";
import { LATEST_OPENAI_MODEL_IDS } from "../providers/known-model-capability.ts";
import type { ModelMessage, ModelToolDefinition } from "../providers/messages.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent, UsageUnits } from "../providers/stream.ts";
import type {
  OpenAiResponsesTransportCompatibilityDeclaration,
  ProviderModelTransportCompatibilityOverride,
  ProviderTransportCompatibilityPlan,
} from "../providers/transport-compatibility.ts";
import { providerDestinationId } from "./provider-destination.ts";
import {
  resolveProviderTransportCompatibilityPlan,
  resolveProviderTransportCompatibilityPlanSet,
} from "./provider-transport-compatibility.ts";

export type OpenAiResponsesSdkFetch = NonNullable<ClientOptions["fetch"]>;

export type OpenAiResponsesSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly baseUrl: string;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly fetch?: OpenAiResponsesSdkFetch;
  readonly supportedModels?: readonly string[];
  readonly organization?: string | null;
  readonly project?: string | null;
  readonly requestTimeoutMs?: number;
  readonly compatibility: OpenAiResponsesTransportCompatibilityDeclaration;
  readonly modelCompatibility?: readonly ProviderModelTransportCompatibilityOverride[];
  readonly continuationState?: ProviderContinuationStatePort;
  /** Injectable for deterministic persistence fixtures. */
  readonly now?: () => number;
};

type ToolCallState = {
  callId: string | null;
  name: string | null;
  arguments: string;
  emittedArguments: string;
  argumentsDone: boolean;
  outputDone: boolean;
  proposed: boolean;
  seenAdded: boolean;
  itemId: string;
};

type RetainedContinuation = {
  readonly responseId: string;
  readonly reasoning: readonly ResponseReasoningItem[];
};

const MAX_RETAINED_TOOL_CALLS = 256;
const MAX_CONTINUATION_STATE_JSON_LENGTH = 4 * 1024 * 1024;

class OpenAiResponsesInputError extends Error {
  readonly failureKind: ProviderFailureKind;

  constructor(failureKind: ProviderFailureKind, message: string) {
    super(message);
    this.name = "OpenAiResponsesInputError";
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

function classifySdkError(error: unknown, signal: AbortSignal): ProviderFailure {
  if (signal.aborted || error instanceof APIUserAbortError) {
    return failure("cancellation", "The provider request was cancelled.", false);
  }
  if (error instanceof OpenAiResponsesInputError) {
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
  return failure("adapter-defect", "The OpenAI Responses adapter failed unexpectedly.", false);
}

function responseFailure(response: Response): ProviderFailure {
  const code = response.error?.code;
  if (code === "rate_limit_exceeded") {
    return failure("rate-limit", "The provider rate-limited this response.", true);
  }
  if (code === "bio_policy") {
    return failure("provider-safety", "The provider refused this response.", false);
  }
  if (code === "server_error" || code === null || code === undefined) {
    return failure("server-failure", "The provider failed this response.", true);
  }
  return failure("invalid-request", "The provider rejected this response.", false);
}

function clientFor(options: OpenAiResponsesSdkAdapterOptions, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: options.baseUrl.replace(/\/+$/u, ""),
    organization: options.organization ?? null,
    project: options.project ?? null,
    maxRetries: 0,
    timeout: options.requestTimeoutMs ?? 120_000,
    logLevel: "off",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

function textOf(message: ModelMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function rejectImageParts(messages: readonly ModelMessage[]): void {
  if (messages.some((message) => message.parts.some((part) => part.kind === "image"))) {
    throw new OpenAiResponsesInputError(
      "unsupported-capability",
      "The OpenAI Responses adapter cannot resolve image handles in this request.",
    );
  }
}

function toTools(
  tools: readonly ModelToolDefinition[],
  compatibility: OpenAiResponsesTransportCompatibilityDeclaration,
): FunctionTool[] | undefined {
  return tools.length === 0
    ? undefined
    : tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: compatibility.strictToolSchemas,
      }));
}

function reasoningEffort(
  control: string | null | undefined,
): NonNullable<ResponseCreateParamsStreaming["reasoning"]>["effort"] | undefined {
  switch (control) {
    case undefined:
    case null:
      return undefined;
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return control;
    default:
      throw new OpenAiResponsesInputError(
        "unsupported-capability",
        "The selected OpenAI model does not support the requested reasoning control.",
      );
  }
}

function previousResponse(
  messages: readonly ModelMessage[],
  retained: ReadonlyMap<string, RetainedContinuation>,
): { readonly responseId: string; readonly assistantIndex: number } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.toolCalls === undefined) {
      continue;
    }
    const responseIds = new Set(
      message.toolCalls
        .map((call) => retained.get(call.toolCallId)?.responseId)
        .filter((id): id is string => id !== undefined),
    );
    if (responseIds.size === 1) {
      return { responseId: [...responseIds][0] as string, assistantIndex: index };
    }
  }
  return null;
}

function toInput(
  messages: readonly ModelMessage[],
  compatibility: OpenAiResponsesTransportCompatibilityDeclaration,
  retained: ReadonlyMap<string, RetainedContinuation>,
): { readonly input: ResponseInput; readonly previousResponseId: string | null } {
  rejectImageParts(messages);
  const prior =
    compatibility.continuation === "previous-response"
      ? previousResponse(messages, retained)
      : null;
  const selected = prior === null ? messages : messages.slice(prior.assistantIndex + 1);
  const input: ResponseInput = [];
  const replayedReasoning = new Set<string>();

  for (const message of messages) {
    if (message.role !== "system") {
      continue;
    }
    input.push({
      role: compatibility.systemMessageRole,
      content: textOf(message),
    });
  }

  for (const message of selected) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new OpenAiResponsesInputError(
          "invalid-request",
          "An OpenAI Responses tool result is missing its call identity.",
        );
      }
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: textOf(message),
      });
      continue;
    }
    if (message.role === "assistant") {
      const assistantText = textOf(message);
      if (assistantText.length > 0) {
        input.push({ role: "assistant", content: assistantText });
      }
      for (const call of message.toolCalls ?? []) {
        if (compatibility.continuation === "stateless") {
          for (const item of retained.get(call.toolCallId)?.reasoning ?? []) {
            if (!replayedReasoning.has(item.id)) {
              input.push(item);
              replayedReasoning.add(item.id);
            }
          }
        }
        input.push({
          type: "function_call",
          call_id: call.toolCallId,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }
    input.push({ role: "user", content: textOf(message) });
  }
  return { input, previousResponseId: prior?.responseId ?? null };
}

function usageOf(response: Response): UsageUnits | null {
  const usage: ResponseUsage | null | undefined = response.usage;
  return usage === null || usage === undefined
    ? null
    : {
        provenance: "provider-reported",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
        cachedInputTokens: usage.input_tokens_details.cached_tokens,
        cacheWriteInputTokens: usage.input_tokens_details.cache_write_tokens,
        reasoningTokens: usage.output_tokens_details.reasoning_tokens,
      };
}

function finishReason(response: Response): string {
  return response.incomplete_details?.reason === undefined || response.incomplete_details === null
    ? (response.status ?? "unknown")
    : `${response.status ?? "unknown"}:${response.incomplete_details.reason}`;
}

function responseBody(
  request: ModelRequest,
  compatibility: OpenAiResponsesTransportCompatibilityDeclaration,
  retained: ReadonlyMap<string, RetainedContinuation>,
): ResponseCreateParamsStreaming {
  const translated = toInput(request.messages, compatibility, retained);
  const tools = toTools(request.tools, compatibility);
  const effort = reasoningEffort(request.reasoningControl);
  const summary =
    compatibility.reasoningSummary === "none" ? undefined : compatibility.reasoningSummary;
  const format =
    request.output.kind === "text"
      ? undefined
      : {
          type: "json_schema" as const,
          name: request.output.name,
          schema: request.output.schema,
          strict: true,
        };
  return {
    model: String(request.modelId),
    stream: true,
    input: translated.input,
    store: compatibility.store,
    service_tier: compatibility.serviceTier,
    parallel_tool_calls: compatibility.parallelToolCalls,
    ...(compatibility.streamObfuscation ? {} : { stream_options: { include_obfuscation: false } }),
    ...(translated.previousResponseId === null
      ? {}
      : { previous_response_id: translated.previousResponseId }),
    ...(compatibility.includeEncryptedReasoning
      ? { include: ["reasoning.encrypted_content" as const] }
      : {}),
    ...(request.budgets.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.budgets.maxOutputTokens }),
    ...(tools === undefined ? {} : { tools }),
    ...(effort === undefined && summary === undefined
      ? {}
      : {
          reasoning: {
            ...(effort === undefined ? {} : { effort }),
            ...(summary ? { summary } : {}),
          },
        }),
    ...(format === undefined && request.responseDensityControl == null
      ? {}
      : {
          text: {
            ...(format === undefined ? {} : { format }),
            ...(request.responseDensityControl == null
              ? {}
              : { verbosity: request.responseDensityControl }),
          },
        }),
    ...(request.promptCache === undefined
      ? {}
      : {
          prompt_cache_key: request.promptCache.key,
          ...(compatibility.promptCacheTtl === "30m"
            ? { prompt_cache_options: { ttl: "30m" as const } }
            : {}),
        }),
  };
}

function retain(
  retained: Map<string, RetainedContinuation>,
  callId: string,
  value: RetainedContinuation,
): void {
  retained.delete(callId);
  retained.set(callId, value);
  while (retained.size > MAX_RETAINED_TOOL_CALLS) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    retained.delete(oldest);
  }
}

function parseRetainedContinuation(stateJson: string): RetainedContinuation | null {
  if (stateJson.length === 0 || stateJson.length > MAX_CONTINUATION_STATE_JSON_LENGTH) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(stateJson) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION ||
    typeof record.responseId !== "string" ||
    record.responseId.length === 0 ||
    !Array.isArray(record.reasoning) ||
    record.reasoning.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        (item as Record<string, unknown>).type !== "reasoning" ||
        typeof (item as Record<string, unknown>).id !== "string" ||
        ((item as Record<string, unknown>).id as string).length === 0,
    )
  ) {
    return null;
  }
  return {
    responseId: record.responseId,
    reasoning: record.reasoning as ResponseReasoningItem[],
  };
}

function continuationStateJson(value: RetainedContinuation): string {
  return JSON.stringify({
    schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
    responseId: value.responseId,
    reasoning: value.reasoning,
  });
}

function assistantToolCallIds(messages: readonly ModelMessage[]): readonly string[] {
  return [
    ...new Set(
      messages.flatMap((message) =>
        message.role === "assistant"
          ? (message.toolCalls ?? []).map((call) => call.toolCallId)
          : [],
      ),
    ),
  ];
}

/** Create a direct official-SDK Responses transport adapter. */
export function createOpenAiResponsesSdkAdapter(
  options: OpenAiResponsesSdkAdapterOptions,
): ProviderAdapterPort {
  const models = (options.supportedModels ?? LATEST_OPENAI_MODEL_IDS).map((id) =>
    modelId.from(String(id)),
  );
  const resolvedCompatibility = resolveProviderTransportCompatibilityPlanSet(
    "openai",
    options.compatibility,
    models,
    options.modelCompatibility,
  );
  if (!resolvedCompatibility.ok) {
    throw new Error("OpenAI Responses adapter received an incompatible transport declaration");
  }
  const transportCompatibility = resolvedCompatibility.value.destination;
  if (transportCompatibility.declaration.dialect !== "openai-responses") {
    throw new Error("OpenAI Responses adapter requires the Responses dialect");
  }
  const compatibilityByModel = new Map(
    resolvedCompatibility.value.models.map((entry) => [String(entry.modelId), entry.plan]),
  );
  const retained = new Map<string, RetainedContinuation>();
  const transportCompatibilityFor = (
    selectedModelId: ModelId,
  ): ProviderTransportCompatibilityPlan | null => {
    const bound = compatibilityByModel.get(String(selectedModelId));
    if (bound !== undefined) {
      return bound;
    }
    const resolved = resolveProviderTransportCompatibilityPlan("openai", options.compatibility, {
      modelId: selectedModelId,
      ...(options.modelCompatibility === undefined
        ? {}
        : { modelOverrides: options.modelCompatibility }),
    });
    return resolved.ok ? resolved.value : null;
  };
  const identity = {
    providerId: providerId.from(options.providerId ?? "openai"),
    profileId: options.profileId,
    adapterKind: "openai" as const,
    endpoint: options.baseUrl,
    destinationId: providerDestinationId("openai", options.baseUrl),
    transportCompatibilityId: transportCompatibility.compatibilityId,
    displayName: options.displayName ?? "OpenAI",
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
    requestResponseDensityControls: ["low", "medium", "high"],
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
      if (plan === null || plan.declaration.dialect !== "openai-responses") {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "The selected model has no verified OpenAI Responses transport plan.",
            false,
          ),
        );
        return;
      }
      const compatibility = plan.declaration;
      if (request.promptCache !== undefined && request.promptCache.mode !== "openai-routing-key") {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "The routed prompt-cache mechanism is incompatible with OpenAI Responses.",
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
                "Durable provider continuation state could not be read.",
                false,
              ),
            );
            return;
          }
          if (loaded.value === null) {
            continue;
          }
          const parsed = parseRetainedContinuation(loaded.value.stateJson);
          if (parsed === null) {
            yield errorEvent(
              failure("adapter-defect", "Durable provider continuation state is malformed.", false),
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

      let body: ResponseCreateParamsStreaming;
      try {
        body = responseBody(request, compatibility, retainedForRequest);
      } catch (error) {
        yield errorEvent(classifySdkError(error, streamOptions.signal));
        return;
      }

      const toolCalls = new Map<string, ToolCallState>();
      const toolCallItems = new Map<string, string>();
      const reasoning: ResponseReasoningItem[] = [];
      let refusal = false;
      let malformedToolIdentity = false;
      let unsupportedOutput = false;

      const stateFor = (itemId: string): ToolCallState => {
        const current = toolCalls.get(itemId);
        if (current !== undefined) {
          return current;
        }
        const created: ToolCallState = {
          itemId,
          callId: null,
          name: null,
          arguments: "",
          emittedArguments: "",
          argumentsDone: false,
          outputDone: false,
          proposed: false,
          seenAdded: false,
        };
        toolCalls.set(itemId, created);
        return created;
      };
      const bindToolIdentity = (state: ToolCallState, callId: unknown, name: unknown): boolean => {
        if (
          typeof callId !== "string" ||
          callId.trim() === "" ||
          typeof name !== "string" ||
          name.trim() === ""
        ) {
          malformedToolIdentity = true;
          return false;
        }
        const existingItemId = toolCallItems.get(callId);
        if (existingItemId !== undefined && existingItemId !== state.itemId) {
          malformedToolIdentity = true;
          return false;
        }
        toolCallItems.set(callId, state.itemId);
        state.callId = callId;
        state.name = name;
        return true;
      };

      try {
        const stream = await clientFor(options, apiKey).responses.create(body, {
          signal: streamOptions.signal,
        });
        for await (const event of stream) {
          switch (event.type) {
            case "response.created":
              yield {
                kind: "provider-metadata",
                requestId: request.requestId,
                modelAttemptId: attempt,
                sequence: next(),
                entries: {
                  responseId: event.response.id,
                  status: event.response.status ?? "unknown",
                },
              };
              break;
            case "response.output_text.delta":
              if (event.delta.length > 0) {
                yield {
                  kind: "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: event.delta,
                };
              }
              break;
            case "response.reasoning_text.delta":
            case "response.reasoning_summary_text.delta":
              if (event.delta.length > 0) {
                yield {
                  kind: "reasoning-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: event.delta,
                };
              }
              break;
            case "response.refusal.delta":
              refusal = true;
              if (event.delta.length > 0) {
                yield {
                  kind: "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: event.delta,
                };
              }
              break;
            case "response.output_item.added": {
              if (event.item.type !== "function_call") {
                break;
              }
              const state = stateFor(event.item.id ?? event.item.call_id);
              if (state.seenAdded) {
                malformedToolIdentity = true;
              }
              state.seenAdded = true;
              bindToolIdentity(state, event.item.call_id, event.item.name);
              state.arguments = event.item.arguments;
              break;
            }
            case "response.function_call_arguments.delta": {
              const state = stateFor(event.item_id);
              if (!state.seenAdded || state.argumentsDone || state.outputDone) {
                malformedToolIdentity = true;
              }
              state.arguments += event.delta;
              if (state.callId !== null) {
                state.emittedArguments += event.delta;
                yield {
                  kind: "tool-call-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  toolCallId: state.callId,
                  ...(state.name === null ? {} : { name: state.name }),
                  argumentsFragment: event.delta,
                };
              }
              break;
            }
            case "response.function_call_arguments.done": {
              const state = stateFor(event.item_id);
              if (!state.seenAdded || state.argumentsDone || state.outputDone) {
                malformedToolIdentity = true;
              }
              state.argumentsDone = true;
              if (state.name !== null && state.name !== event.name) {
                malformedToolIdentity = true;
              }
              state.name = event.name;
              state.arguments = event.arguments;
              if (state.callId !== null && !state.proposed) {
                if (state.emittedArguments.length === 0) {
                  yield {
                    kind: "tool-call-delta",
                    requestId: request.requestId,
                    modelAttemptId: attempt,
                    sequence: next(),
                    toolCallId: state.callId,
                    name: event.name,
                    argumentsFragment: event.arguments,
                  };
                }
                yield {
                  kind: "tool-proposal",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  toolCallId: state.callId,
                  name: event.name,
                  argumentsJson: event.arguments,
                };
                state.proposed = true;
              }
              break;
            }
            case "response.output_item.done": {
              const item = event.item;
              if (item.type === "reasoning") {
                reasoning.push(item);
                yield {
                  kind: "provider-metadata",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  entries: { itemId: item.id, itemType: item.type },
                };
                break;
              }
              if (item.type === "function_call") {
                const state = stateFor(item.id ?? item.call_id);
                if (!state.seenAdded || state.outputDone) {
                  malformedToolIdentity = true;
                }
                state.outputDone = true;
                bindToolIdentity(state, item.call_id, item.name);
                state.arguments = item.arguments;
                if (!state.proposed) {
                  if (state.emittedArguments.length === 0) {
                    yield {
                      kind: "tool-call-delta",
                      requestId: request.requestId,
                      modelAttemptId: attempt,
                      sequence: next(),
                      toolCallId: item.call_id,
                      name: item.name,
                      argumentsFragment: item.arguments,
                    };
                  }
                  yield {
                    kind: "tool-proposal",
                    requestId: request.requestId,
                    modelAttemptId: attempt,
                    sequence: next(),
                    toolCallId: item.call_id,
                    name: item.name,
                    argumentsJson: item.arguments,
                  };
                  state.proposed = true;
                }
                yield {
                  kind: "provider-metadata",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  entries: {
                    itemId: item.id ?? state.itemId,
                    itemType: item.type,
                    callId: item.call_id,
                  },
                };
                break;
              }
              if (item.type !== "message") {
                unsupportedOutput = true;
              }
              break;
            }
            case "response.completed":
            case "response.incomplete": {
              const usage = usageOf(event.response);
              if (usage !== null) {
                yield {
                  kind: "usage",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  usage,
                };
              }
              if (
                malformedToolIdentity ||
                [...toolCalls.values()].some(
                  (state) =>
                    !state.seenAdded ||
                    !state.outputDone ||
                    state.callId === null ||
                    state.name === null ||
                    !state.proposed,
                )
              ) {
                yield errorEvent(
                  failure(
                    "malformed-stream",
                    "OpenAI Responses returned malformed or duplicate tool-call identity.",
                    false,
                  ),
                );
                return;
              }
              if (unsupportedOutput) {
                yield errorEvent(
                  failure(
                    "unsupported-capability",
                    "OpenAI Responses returned an output item Falryn did not request.",
                    false,
                  ),
                );
                return;
              }
              if (refusal) {
                yield errorEvent(
                  failure("provider-safety", "The provider refused this response.", false),
                );
                return;
              }
              const proposed = [...toolCalls.values()].filter(
                (state): state is ToolCallState & { callId: string } =>
                  state.callId !== null && state.proposed,
              );
              const retainedValue: RetainedContinuation = {
                responseId: event.response.id,
                reasoning: compatibility.includeEncryptedReasoning ? [...reasoning] : [],
              };
              if (options.continuationState !== undefined && proposed.length > 0) {
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
                  proposed.map((state) => ({
                    ...continuationKey(request.modelId, plan.compatibilityId, state.callId),
                    schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
                    stateJson,
                    capturedAt,
                  })),
                );
                if (!saved.ok) {
                  yield errorEvent(
                    failure(
                      "adapter-defect",
                      "Durable provider continuation state could not be retained.",
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
              for (const state of proposed) {
                retain(retained, state.callId, retainedValue);
              }
              yield {
                kind: "finished",
                requestId: request.requestId,
                modelAttemptId: attempt,
                sequence: next(),
                finishReason: proposed.length > 0 ? "tool_calls" : finishReason(event.response),
              };
              return;
            }
            case "response.failed":
              yield errorEvent(responseFailure(event.response));
              return;
            case "error": {
              const providerFailure =
                event.code === "rate_limit_exceeded"
                  ? failure("rate-limit", "The provider rate-limited this response.", true)
                  : failure("server-failure", "The provider stream failed.", true);
              yield errorEvent(providerFailure);
              return;
            }
            default:
              break;
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
      yield errorEvent(
        failure("malformed-stream", "The provider stream ended without a terminal event.", false),
      );
    },
  };
}
