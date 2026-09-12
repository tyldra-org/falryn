/**
 * Google Gen AI SDK adapter.
 *
 * Falryn owns the provider-neutral request, event, policy, and retry contracts.
 * The official SDK owns authentication, HTTP execution, stream decoding, and
 * endpoint transport inside this leaf adapter.
 */

import {
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
  type Tool,
} from "@google/genai";
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
  type ProviderContinuationStatePort,
  type ProviderContinuationStateRecord,
} from "../../providers/protocol/continuation-state.ts";
import type { ProviderFailure } from "../../providers/protocol/errors.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../../providers/protocol/port.ts";
import type { ModelRequest } from "../../providers/protocol/request.ts";
import type { NormalizedProviderEvent, UsageUnits } from "../../providers/protocol/stream.ts";
import {
  continuationStateJson,
  MAX_CONTINUATION_STATE_JSON_LENGTH,
  MAX_RETAINED_TEXT_LENGTH,
  MAX_RETAINED_THOUGHT_PARTS,
  parseRetainedContinuation,
  retain,
} from "./google-genai-sdk-adapter/continuation.ts";
import type {
  GoogleCachedContentBinding,
  GoogleGenAiSdkAdapterOptions,
  RetainedContinuation,
  SignedThoughtPart,
  ToolCallState,
} from "./google-genai-sdk-adapter/contracts.ts";
import { classifySdkError, failure, GoogleInputError } from "./google-genai-sdk-adapter/errors.ts";
import {
  assistantToolCallIds,
  definedPartPayloadKeys,
  thinkingLevel,
  toGoogleMessages,
  toTools,
} from "./google-genai-sdk-adapter/requests.ts";
import { usageDoesNotRegress, usageFrom } from "./google-genai-sdk-adapter/usage.ts";
import { providerDestinationId } from "./provider-destination.ts";
import { resolveProviderTransportCompatibilityPlanSet } from "./provider-transport-compatibility.ts";

export type {
  GoogleCachedContentBinding,
  GoogleCachedContentBindingPort,
  GoogleGenAiSdkAdapterOptions,
  GoogleGenAiStreamFactory,
} from "./google-genai-sdk-adapter/contracts.ts";

function streamFor(
  options: GoogleGenAiSdkAdapterOptions,
  apiKey: string,
  request: GenerateContentParameters,
): Promise<AsyncIterable<GenerateContentResponse>> {
  if (options.createStream !== undefined) {
    return options.createStream(apiKey, request);
  }
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(options.baseUrl === null || options.baseUrl === undefined
        ? {}
        : { baseUrl: options.baseUrl.replace(/\/+$/u, "") }),
      timeout: options.requestTimeoutMs ?? 120_000,
      retryOptions: { attempts: 1 },
    },
  });
  return client.models.generateContentStream(request);
}

const SAFETY_FINISH_REASONS = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

/** Create a live SDK-backed Google Gen AI adapter. */

export function createGoogleGenAiSdkAdapter(
  options: GoogleGenAiSdkAdapterOptions,
): ProviderAdapterPort {
  const models = options.supportedModels.map((id) => modelId.from(id));
  const resolvedCompatibility = resolveProviderTransportCompatibilityPlanSet(
    "google",
    options.compatibility,
    models,
    options.modelCompatibility,
  );
  if (!resolvedCompatibility.ok) {
    throw new Error("Google Gen AI SDK adapter received an incompatible transport declaration");
  }
  const transportCompatibility = resolvedCompatibility.value.destination;
  if (transportCompatibility.declaration.dialect !== "google-generate-content") {
    throw new Error("Google Gen AI SDK adapter requires the Generate Content dialect");
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
    providerId: providerId.from(options.providerId ?? "google"),
    profileId: options.profileId,
    adapterKind: "google" as const,
    endpoint: options.baseUrl ?? null,
    destinationId: providerDestinationId("google", options.baseUrl ?? null),
    transportCompatibilityId: transportCompatibility.compatibilityId,
    displayName: options.displayName ?? "Google",
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
  const resolveExplicitCache = async (
    request: ModelRequest,
    stable: ReturnType<typeof toGoogleMessages>,
    tools: Tool[] | undefined,
    plan: ProviderTransportCompatibilityPlan,
    signal: AbortSignal,
  ): Promise<GoogleCachedContentBinding | null> => {
    const policy = request.promptCache;
    if (
      policy === undefined ||
      policy.mode !== "google-explicit-resource" ||
      options.cachedContent === undefined
    ) {
      return null;
    }
    try {
      const resolved = await options.cachedContent.resolve({
        profileId: identity.profileId,
        providerId: String(identity.providerId),
        destinationId: identity.destinationId,
        modelId: request.modelId,
        transportCompatibilityId: plan.compatibilityId,
        cacheKey: policy.key,
        stablePrefixDigest: policy.stablePrefixDigest,
        create: {
          model: String(request.modelId),
          config: {
            abortSignal: signal,
            ttl: "300s",
            displayName: `falryn-${policy.key.slice("sha-256:".length, 24)}`,
            ...(stable.contents.length === 0 ? {} : { contents: stable.contents }),
            ...(stable.systemInstruction === undefined
              ? {}
              : { systemInstruction: stable.systemInstruction }),
            ...(tools === undefined ? {} : { tools }),
          },
        },
        signal,
      });
      if (resolved.kind === "unavailable") {
        return null;
      }
      if (
        resolved.name.trim().length === 0 ||
        !Number.isSafeInteger(resolved.cacheWriteInputTokens) ||
        resolved.cacheWriteInputTokens < 0
      ) {
        throw new GoogleInputError(
          "adapter-defect",
          "The Google cached-content binding returned malformed metadata.",
        );
      }
      return resolved;
    } catch (error) {
      if (error instanceof GoogleInputError) {
        throw error;
      }
      // Caching is an optimization. The exact uncached request remains valid.
      return null;
    }
  };

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
      if (plan === null || plan.declaration.dialect !== "google-generate-content") {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "The selected model has no verified Google Generate Content transport plan.",
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
            "The request transport identity does not match the Google Generate Content plan.",
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
            "This Google GenAI SDK route has no verified native response-density control.",
            false,
          ),
        );
        return;
      }
      if (
        request.promptCache !== undefined &&
        request.promptCache.mode !== "google-explicit-resource" &&
        request.promptCache.mode !== "implicit-prefix"
      ) {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "The routed prompt-cache mechanism is incompatible with Google GenAI.",
            false,
          ),
        );
        return;
      }
      if (
        request.output.kind === "json-schema" &&
        compatibility.structuredOutput !== "response-json-schema"
      ) {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "This Google Generate Content plan does not permit structured output.",
            false,
          ),
        );
        return;
      }
      if (
        request.reasoningControl !== null &&
        request.reasoningControl !== undefined &&
        compatibility.thinking !== "thinking-level"
      ) {
        yield errorEvent(
          failure(
            "unsupported-capability",
            "This Google Generate Content plan does not permit thinking-level control.",
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
                "Durable Google continuation state could not be read.",
                false,
              ),
            );
            return;
          }
          if (loaded.value === null) {
            yield errorEvent(
              failure(
                "adapter-defect",
                "Required durable Google continuation state is unavailable.",
                false,
              ),
            );
            return;
          }
          const parsed = parseRetainedContinuation(loaded.value.stateJson);
          if (parsed === null) {
            yield errorEvent(
              failure("adapter-defect", "Durable Google continuation state is malformed.", false),
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

      let sdkRequest: GenerateContentParameters;
      let cacheWriteInputTokens: number | undefined;
      try {
        let translated = toGoogleMessages(request.messages, retainedForRequest);
        const deferredCount = request.tools.filter((tool) => tool.deferred === true).length;
        if (deferredCount > 0) {
          yield {
            kind: "provider-metadata",
            requestId: request.requestId,
            modelAttemptId: attempt,
            sequence: next(),
            entries: {
              toolDeferral: "unsupported-transport-omitted",
              deferredToolCount: String(deferredCount),
            },
          };
        }
        const tools = toTools(request.tools);
        const level = thinkingLevel(request.reasoningControl);
        let cachedContent: string | undefined;
        let requestTools = tools;
        if (request.promptCache?.mode === "google-explicit-resource") {
          try {
            const stableMessages = request.messages.slice(
              0,
              request.promptCache.stableMessageCount,
            );
            const dynamicMessages = request.messages.slice(request.promptCache.stableMessageCount);
            const stable = toGoogleMessages(stableMessages, retainedForRequest, {
              allowSystemOnly: true,
            });
            const dynamic = toGoogleMessages(dynamicMessages, retainedForRequest);
            if (dynamic.systemInstruction === undefined && dynamic.contents.length > 0) {
              const resolved = await resolveExplicitCache(
                request,
                stable,
                tools,
                plan,
                streamOptions.signal,
              );
              if (resolved !== null) {
                translated = dynamic;
                cachedContent = resolved.name;
                cacheWriteInputTokens = resolved.cacheWriteInputTokens;
                requestTools = undefined;
              }
            }
          } catch (error) {
            if (error instanceof GoogleInputError && error.failureKind === "adapter-defect") {
              throw error;
            }
            // A prefix split may cut a function call from its response. The
            // already-validated exact request remains the safe fallback.
          }
        }
        if (streamOptions.signal.aborted) {
          throw new DOMException("The request was cancelled.", "AbortError");
        }
        sdkRequest = {
          model: String(request.modelId),
          contents: translated.contents,
          config: {
            abortSignal: streamOptions.signal,
            ...(translated.systemInstruction === undefined
              ? {}
              : { systemInstruction: translated.systemInstruction }),
            ...(requestTools === undefined ? {} : { tools: requestTools }),
            ...(cachedContent === undefined ? {} : { cachedContent }),
            automaticFunctionCalling: { disable: true },
            ...(level === undefined
              ? {}
              : { thinkingConfig: { thinkingLevel: level, includeThoughts: true } }),
            ...(request.budgets.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: request.budgets.maxOutputTokens }),
            ...(request.output.kind === "json-schema"
              ? {
                  responseMimeType: "application/json",
                  responseJsonSchema: request.output.schema,
                }
              : {}),
          },
        };
      } catch (error) {
        yield errorEvent(classifySdkError(error, streamOptions.signal));
        return;
      }

      const toolCalls = new Map<string, ToolCallState>();
      const functionSignatures = new Map<string, string | null>();
      const signedThoughts: SignedThoughtPart[] = [];
      let retainedTextLength = 0;
      let functionOrdinal = 0;
      let finishReason: string | null = null;
      let finalUsage: UsageUnits | null = null;
      let promptBlocked = false;
      let terminalSeen = false;

      try {
        const stream = await streamFor(options, apiKey, sdkRequest);
        for await (const chunk of stream) {
          const candidates = chunk.candidates ?? [];
          const nextUsage = usageFrom(chunk);
          if (
            terminalSeen &&
            (candidates.length > 0 || nextUsage !== null || chunk.promptFeedback !== undefined)
          ) {
            throw new GoogleInputError(
              "malformed-stream",
              "Google emitted data after its terminal candidate.",
            );
          }
          if (nextUsage !== null) {
            if (!usageDoesNotRegress(finalUsage, nextUsage)) {
              throw new GoogleInputError(
                "malformed-stream",
                "Google usage counters regressed during the stream.",
              );
            }
            finalUsage = nextUsage;
          }
          if (chunk.promptFeedback?.blockReason !== undefined) {
            if (candidates.length > 0) {
              throw new GoogleInputError(
                "malformed-stream",
                "Google returned both blocked prompt feedback and candidates.",
              );
            }
            promptBlocked = true;
          }
          if (candidates.length > 1) {
            throw new GoogleInputError(
              "malformed-stream",
              "Google returned more than one streamed candidate.",
            );
          }
          const candidate = candidates[0];
          if (candidate === undefined) {
            continue;
          }
          if ((candidate.index ?? 0) !== 0) {
            throw new GoogleInputError(
              "malformed-stream",
              "Google returned a nonzero candidate index for a single-candidate route.",
            );
          }
          if (candidate.content?.role !== undefined && candidate.content.role !== "model") {
            throw new GoogleInputError(
              "malformed-stream",
              "Google returned a candidate with an invalid role.",
            );
          }
          for (const part of candidate.content?.parts ?? []) {
            const payloadKeys = definedPartPayloadKeys(part);
            if (payloadKeys.length !== 1) {
              throw new GoogleInputError(
                "malformed-stream",
                "Google returned a part with an invalid payload shape.",
              );
            }
            if (payloadKeys[0] === "text") {
              if (typeof part.text !== "string") {
                throw new GoogleInputError("malformed-stream", "Google returned invalid text.");
              }
              if (part.thought !== true && part.thoughtSignature !== undefined) {
                throw new GoogleInputError(
                  "malformed-stream",
                  "Google attached a thought signature to ordinary text.",
                );
              }
              if (part.text.length > 0) {
                yield {
                  kind: part.thought === true ? "reasoning-delta" : "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: part.text,
                };
              }
              if (part.thought === true && part.thoughtSignature !== undefined) {
                if (
                  part.thoughtSignature.length === 0 ||
                  signedThoughts.length >= MAX_RETAINED_THOUGHT_PARTS
                ) {
                  throw new GoogleInputError(
                    "unsupported-capability",
                    "Google thought continuation state exceeds Falryn's bound.",
                  );
                }
                retainedTextLength += part.text.length + part.thoughtSignature.length;
                if (retainedTextLength > MAX_RETAINED_TEXT_LENGTH) {
                  throw new GoogleInputError(
                    "unsupported-capability",
                    "Google thought continuation state exceeds Falryn's bound.",
                  );
                }
                signedThoughts.push({
                  text: part.text,
                  thought: true,
                  thoughtSignature: part.thoughtSignature,
                });
              }
              continue;
            }
            if (payloadKeys[0] !== "functionCall" || part.functionCall === undefined) {
              throw new GoogleInputError(
                "unsupported-capability",
                "Google returned an unsupported response part.",
              );
            }
            const call = part.functionCall;
            if (
              typeof call.name !== "string" ||
              call.name.trim().length === 0 ||
              call.willContinue === true ||
              (call.partialArgs !== undefined && call.partialArgs.length > 0) ||
              (call.args !== undefined &&
                (typeof call.args !== "object" || call.args === null || Array.isArray(call.args)))
            ) {
              throw new GoogleInputError(
                "malformed-stream",
                "Google returned an incomplete or malformed function call.",
              );
            }
            const id =
              typeof call.id === "string" && call.id.length > 0
                ? call.id
                : `tool-0-${functionOrdinal}`;
            functionOrdinal += 1;
            if (toolCalls.has(id)) {
              throw new GoogleInputError(
                "malformed-stream",
                "Google returned a duplicate function-call identity.",
              );
            }
            if (part.thoughtSignature !== undefined && part.thoughtSignature.length === 0) {
              throw new GoogleInputError(
                "malformed-stream",
                "Google returned an empty function thought signature.",
              );
            }
            const argumentsJson = JSON.stringify(call.args ?? {});
            toolCalls.set(id, { id, name: call.name, argumentsJson });
            functionSignatures.set(id, part.thoughtSignature ?? null);
            yield {
              kind: "tool-call-delta",
              requestId: request.requestId,
              modelAttemptId: attempt,
              sequence: next(),
              toolCallId: id,
              name: call.name,
              argumentsFragment: argumentsJson,
            };
          }
          const reason = candidate.finishReason;
          if (reason !== undefined && reason !== "FINISH_REASON_UNSPECIFIED") {
            if (finishReason !== null) {
              throw new GoogleInputError(
                "malformed-stream",
                "Google returned more than one terminal finish reason.",
              );
            }
            finishReason = reason;
            terminalSeen = true;
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
      if (finishReason === null) {
        yield errorEvent(
          promptBlocked
            ? failure("provider-safety", "The provider blocked this request.", false)
            : failure(
                "malformed-stream",
                "The provider stream ended without a terminal event.",
                false,
              ),
        );
        return;
      }
      if (SAFETY_FINISH_REASONS.has(finishReason)) {
        yield errorEvent(failure("provider-safety", "The provider blocked this request.", false));
        return;
      }
      if (finishReason === "MALFORMED_FUNCTION_CALL" || finishReason === "UNEXPECTED_TOOL_CALL") {
        yield errorEvent(
          failure("invalid-request", "The provider returned an invalid function call.", false),
        );
        return;
      }
      if (finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
        yield errorEvent(
          failure(
            finishReason === "LANGUAGE" ? "invalid-request" : "server-failure",
            "The provider ended the request with an unsupported terminal reason.",
            false,
          ),
        );
        return;
      }

      const proposed = [...toolCalls.values()];
      if (proposed.length > 0 && options.continuationState !== undefined) {
        const capturedAt = Math.max(0, Math.trunc(options.now?.() ?? Date.now()));
        const records: ProviderContinuationStateRecord[] = [];
        for (const tool of proposed) {
          const value: RetainedContinuation = {
            signedThoughts,
            functionThoughtSignature: functionSignatures.get(tool.id) ?? null,
          };
          const stateJson = continuationStateJson(value);
          if (stateJson.length > MAX_CONTINUATION_STATE_JSON_LENGTH) {
            yield errorEvent(
              failure(
                "unsupported-capability",
                "Google continuation state exceeds Falryn's durable bound.",
                false,
              ),
            );
            return;
          }
          records.push({
            ...continuationKey(request.modelId, plan.compatibilityId, tool.id),
            schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
            stateJson,
            capturedAt,
          });
        }
        let saved: ReturnType<ProviderContinuationStatePort["save"]>;
        try {
          saved = options.continuationState.save(records);
        } catch {
          yield errorEvent(
            failure(
              "adapter-defect",
              "Durable Google continuation state could not be retained.",
              false,
            ),
          );
          return;
        }
        if (!saved.ok) {
          yield errorEvent(
            failure(
              "adapter-defect",
              "Durable Google continuation state could not be retained.",
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
      for (const tool of proposed) {
        retain(retained, tool.id, {
          signedThoughts,
          functionThoughtSignature: functionSignatures.get(tool.id) ?? null,
        });
        yield {
          kind: "tool-proposal",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          toolCallId: tool.id,
          name: tool.name,
          argumentsJson: tool.argumentsJson,
        };
      }
      if (finalUsage !== null) {
        yield {
          kind: "usage",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          usage:
            cacheWriteInputTokens === undefined
              ? finalUsage
              : { ...finalUsage, cacheWriteInputTokens },
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
