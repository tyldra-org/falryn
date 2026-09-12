import { supportsNativeToolSearch } from "../../providers/configuration/transport-compatibility.ts";
import { MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH } from "../../providers/protocol/limits.ts";
/**
 * Anthropic SDK Messages adapter.
 *
 * Falryn owns the provider-neutral request, event, policy, and retry contracts.
 * The official SDK owns authentication headers, HTTP execution, SSE decoding,
 * and endpoint transport inside this leaf adapter.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";
import {
  type ModelId,
  modelAttemptId,
  modelId,
  providerId,
} from "../../domain/foundation/identity.ts";
import type { ProviderTransportCompatibilityPlan } from "../../providers/configuration/transport-compatibility.ts";
import {
  PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
  type ProviderContinuationStateKey,
} from "../../providers/protocol/continuation-state.ts";
import type { ProviderFailure } from "../../providers/protocol/errors.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../../providers/protocol/port.ts";
import type { ModelRequest } from "../../providers/protocol/request.ts";
import type { NormalizedProviderEvent, UsageUnits } from "../../providers/protocol/stream.ts";
import {
  continuationStateJson,
  MAX_CONTINUATION_STATE_JSON_LENGTH,
  parseRetainedContinuation,
  retain,
} from "./anthropic-sdk-adapter/continuation.ts";
import type {
  AnthropicSdkAdapterOptions,
  ContentBlockState,
  RetainedContinuation,
  RetainedThinkingBlock,
} from "./anthropic-sdk-adapter/contracts.ts";
import { AnthropicInputError, classifySdkError, failure } from "./anthropic-sdk-adapter/errors.ts";
import {
  anthropicReasoningEffort,
  assistantToolCallIds,
  toAnthropicMessages,
  toTools,
} from "./anthropic-sdk-adapter/requests.ts";
import { providerDestinationId } from "./provider-destination.ts";
import { resolveProviderTransportCompatibilityPlanSet } from "./provider-transport-compatibility.ts";

export type {
  AnthropicSdkAdapterOptions,
  AnthropicSdkFetch,
  AnthropicSdkStreamFactory,
} from "./anthropic-sdk-adapter/contracts.ts";

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
      if (!supportsNativeToolSearch(compatibility, String(request.modelId))) {
        request = { ...request, tools: request.tools.filter((tool) => tool.deferred !== true) };
      }
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

      for (const callId of assistantToolCallIds(request.messages)) {
        for (const block of retainedForRequest.get(callId)?.search ?? []) {
          if (
            block.type === "tool_search_tool_result" &&
            block.content.type === "tool_search_tool_search_result" &&
            block.content.tool_references.some(
              (reference) => !request.tools.some((tool) => tool.name === reference.tool_name),
            )
          ) {
            yield errorEvent(
              failure(
                "invalid-request",
                "Retained tool search references are no longer eligible.",
                false,
              ),
            );
            return;
          }
        }
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

      const deferredToolNames = new Set(
        request.tools.filter((tool) => tool.deferred === true).map((tool) => tool.name),
      );
      const loadedDeferredTools = new Set<string>();
      let toolSearchCalls = 0;
      if (deferredToolNames.size > 0) {
        yield {
          kind: "provider-metadata",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          entries: {
            toolDeferral: "anthropic-tool-search",
            deferredToolCount: String(deferredToolNames.size),
          },
        };
      }

      const contentBlocks = new Map<number, ContentBlockState>();
      const toolCallIds = new Set<string>();
      const thinking: RetainedThinkingBlock[] = [];
      const search: NonNullable<RetainedContinuation["search"]>[number][] = [];
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
              } else if (block.type === "server_tool_use") {
                contentBlocks.set(event.index, {
                  type: "server-tool",
                  name: block.name,
                  retained: {
                    type: "server_tool_use",
                    id: block.id,
                    name: block.name,
                    input: block.input,
                  },
                  arguments: "",
                  stopped: false,
                });
                if (
                  block.name === "tool_search_tool_bm25" ||
                  block.name === "tool_search_tool_regex"
                ) {
                  toolSearchCalls += 1;
                }
                yield {
                  kind: "provider-metadata",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  entries: { itemType: "server_tool_use", toolName: block.name },
                };
              } else if (block.type === "tool_search_tool_result") {
                search.push(block);
                contentBlocks.set(event.index, {
                  type: "server-tool",
                  name: "tool_search_tool_result",
                  stopped: false,
                });
                const entries: Record<string, string> = { itemType: block.type };
                if (block.content.type === "tool_search_tool_search_result") {
                  for (const reference of block.content.tool_references) {
                    if (deferredToolNames.has(reference.tool_name)) {
                      loadedDeferredTools.add(reference.tool_name);
                    }
                  }
                  entries.deferredToolsLoaded = [...loadedDeferredTools].join(",");
                } else {
                  entries.toolSearchError = block.content.error_code;
                }
                yield {
                  kind: "provider-metadata",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  entries,
                };
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
                if (block.type === "server-tool") {
                  const argumentsText = (block.arguments ?? "") + event.delta.partial_json;
                  if (argumentsText.length > MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH)
                    throw new AnthropicInputError(
                      "malformed-stream",
                      "Tool search arguments exceeded the continuation bound.",
                    );
                  block.arguments = argumentsText;
                  break;
                }
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
              if (block.type === "server-tool" && block.retained) {
                search.push({
                  ...block.retained,
                  input: block.arguments ? JSON.parse(block.arguments) : block.retained.input,
                });
              } else if (block.type === "thinking") {
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
      const retainedValue: RetainedContinuation = { thinking, search };
      if (parseRetainedContinuation(continuationStateJson(retainedValue)) === null) {
        yield errorEvent(
          failure("malformed-stream", "Invalid or oversized tool continuation state.", false),
        );
        return;
      }
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
      if (toolSearchCalls > 0 || loadedDeferredTools.size > 0) {
        yield {
          kind: "provider-metadata",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          entries: {
            toolSearchCalls: String(toolSearchCalls),
            deferredToolsLoaded: [...loadedDeferredTools].join(","),
          },
        };
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
