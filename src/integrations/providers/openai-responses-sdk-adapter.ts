/** Official OpenAI SDK adapter for the Responses transport. */

import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseReasoningItem,
  ResponseUsage,
} from "openai/resources/responses/responses";
import {
  type ModelId,
  modelAttemptId,
  modelId,
  providerId,
} from "../../domain/foundation/identity.ts";
import { LATEST_OPENAI_MODEL_IDS } from "../../providers/catalog/known-model-capability.ts";
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
} from "./openai-responses-sdk-adapter/continuation.ts";
import type {
  OpenAiResponsesSdkAdapterOptions,
  RetainedContinuation,
  ToolCallState,
} from "./openai-responses-sdk-adapter/contracts.ts";
import {
  classifySdkError,
  failure,
  responseFailure,
} from "./openai-responses-sdk-adapter/errors.ts";
import { assistantToolCallIds, responseBody } from "./openai-responses-sdk-adapter/requests.ts";
import { providerDestinationId } from "./provider-destination.ts";
import {
  resolveProviderTransportCompatibilityPlan,
  resolveProviderTransportCompatibilityPlanSet,
} from "./provider-transport-compatibility.ts";

export type {
  OpenAiResponsesSdkAdapterOptions,
  OpenAiResponsesSdkFetch,
} from "./openai-responses-sdk-adapter/contracts.ts";

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
      const deferredToolNames = new Set(
        request.tools.filter((tool) => tool.deferred === true).map((tool) => tool.name),
      );
      let toolSearchCalls = 0;
      const loadedDeferredTools = new Set<string>();
      if (deferredToolNames.size > 0) {
        yield {
          kind: "provider-metadata",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          entries: {
            toolDeferral: "openai-tool-search",
            deferredToolCount: String(deferredToolNames.size),
          },
        };
      }

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
              if (item.type === "tool_search_call") {
                toolSearchCalls += 1;
                yield {
                  kind: "provider-metadata",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  entries: {
                    itemId: item.id ?? "",
                    itemType: item.type,
                    execution: item.execution ?? "server",
                  },
                };
                break;
              }
              if (item.type === "tool_search_output") {
                for (const loaded of item.tools) {
                  if (loaded.type === "function" && deferredToolNames.has(loaded.name)) {
                    loadedDeferredTools.add(loaded.name);
                  }
                }
                yield {
                  kind: "provider-metadata",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  entries: {
                    itemId: item.id,
                    itemType: item.type,
                    deferredToolsLoaded: [...loadedDeferredTools].join(","),
                  },
                };
                break;
              }
              if (item.type === "additional_tools") {
                yield {
                  kind: "provider-metadata",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  entries: { itemId: item.id ?? "", itemType: item.type },
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
