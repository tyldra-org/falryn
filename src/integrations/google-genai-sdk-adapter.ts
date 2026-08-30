/**
 * Google Gen AI SDK adapter.
 *
 * Falryn owns the provider-neutral request, event, policy, and retry contracts.
 * The official SDK owns authentication, HTTP execution, stream decoding, and
 * endpoint transport inside this leaf adapter.
 */

import {
  ApiError,
  type CachedContent,
  type Content,
  type CreateCachedContentParameters,
  type GenerateContentParameters,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
  ThinkingLevel,
  type Tool,
} from "@google/genai";

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import type { ProviderFailure, ProviderFailureKind } from "../providers/errors.ts";
import type { ModelMessage, ModelToolDefinition } from "../providers/messages.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent, UsageUnits } from "../providers/stream.ts";
import type { GoogleGenerateContentTransportCompatibilityDeclaration } from "../providers/transport-compatibility.ts";
import { providerDestinationId } from "./provider-destination.ts";
import { resolveProviderTransportCompatibilityPlan } from "./provider-transport-compatibility.ts";

export type GoogleGenAiStreamFactory = (
  apiKey: string,
  request: GenerateContentParameters,
) => Promise<AsyncIterable<GenerateContentResponse>>;

export type GoogleGenAiCacheFactory = (
  apiKey: string,
  request: CreateCachedContentParameters,
) => Promise<CachedContent>;

export type GoogleGenAiSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly baseUrl?: string | null;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly supportedModels: readonly string[];
  readonly requestTimeoutMs?: number;
  /** Deterministic SDK boundary used by tests. Production leaves this absent. */
  readonly createStream?: GoogleGenAiStreamFactory;
  /** Deterministic cache boundary used by tests. Production leaves this absent. */
  readonly createCache?: GoogleGenAiCacheFactory;
  readonly compatibility?: GoogleGenerateContentTransportCompatibilityDeclaration;
};

type ToolCallState = {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
};

function thinkingLevel(control: string | null | undefined): ThinkingLevel | undefined {
  switch (control) {
    case undefined:
    case null:
      return undefined;
    case "minimal":
      return ThinkingLevel.MINIMAL;
    case "low":
      return ThinkingLevel.LOW;
    case "medium":
    case "balanced":
      return ThinkingLevel.MEDIUM;
    case "high":
    case "deep":
      return ThinkingLevel.HIGH;
    default:
      throw new GoogleInputError(
        "unsupported-capability",
        "The selected Google model does not support the requested reasoning control.",
      );
  }
}

class GoogleInputError extends Error {
  readonly failureKind: ProviderFailureKind;

  constructor(failureKind: ProviderFailureKind, message: string) {
    super(message);
    this.name = "GoogleInputError";
    this.failureKind = failureKind;
  }
}

function failure(kind: ProviderFailureKind, message: string, retryable: boolean): ProviderFailure {
  return { kind, message, retryable };
}

function textOf(message: ModelMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function rejectImageParts(messages: readonly ModelMessage[]): void {
  if (messages.some((message) => message.parts.some((part) => part.kind === "image"))) {
    throw new GoogleInputError(
      "unsupported-capability",
      "The Google adapter cannot resolve image handles in this request.",
    );
  }
}

function toolNames(messages: readonly ModelMessage[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      names.set(call.toolCallId, call.name);
    }
  }
  return names;
}

function functionResponseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toGoogleMessages(messages: readonly ModelMessage[]): {
  readonly systemInstruction: string | undefined;
  readonly contents: Content[];
} {
  rejectImageParts(messages);
  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map(textOf)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const names = toolNames(messages);
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new GoogleInputError(
          "invalid-request",
          "A Google tool result requires a matching tool call identity.",
        );
      }
      const name = names.get(message.toolCallId);
      if (name === undefined) {
        throw new GoogleInputError(
          "invalid-request",
          "A Google tool result requires the originating tool name.",
        );
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              id: message.toolCallId,
              name,
              response: { output: functionResponseValue(textOf(message)) },
            },
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant") {
      const parts: Part[] = [];
      const text = textOf(message);
      if (text.length > 0) {
        parts.push({ text });
      }
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            id: call.toolCallId,
            name: call.name,
            args: { ...call.arguments },
          },
        });
      }
      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }
    const text = textOf(message);
    if (text.length > 0) {
      contents.push({ role: "user", parts: [{ text }] });
    }
  }

  return {
    systemInstruction: systemInstruction.length === 0 ? undefined : systemInstruction,
    contents,
  };
}

function toTools(tools: readonly ModelToolDefinition[]): Tool[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

function classifySdkError(error: unknown, signal: AbortSignal): ProviderFailure {
  if (
    signal.aborted ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return error instanceof DOMException && error.name === "TimeoutError" && !signal.aborted
      ? failure("timeout", "The provider request timed out.", true)
      : failure("cancellation", "The provider request was cancelled.", false);
  }
  if (error instanceof GoogleInputError) {
    return failure(error.failureKind, error.message, false);
  }
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 409 || error.status === 422) {
      return failure("invalid-request", "The provider rejected the request shape.", false);
    }
    if (error.status === 401) {
      return failure("authentication", "The provider rejected the credentials.", false);
    }
    if (error.status === 403) {
      return failure("authorization", "The provider denied this request.", false);
    }
    if (error.status === 408 || error.status === 504) {
      return failure("timeout", "The provider request timed out.", true);
    }
    if (error.status === 429) {
      return failure("rate-limit", "The provider rate-limited this request.", true);
    }
    if (error.status >= 500) {
      return failure("server-failure", "The provider returned a server failure.", true);
    }
    return failure("invalid-request", "The provider rejected the request.", false);
  }
  if (error instanceof SyntaxError) {
    return failure("malformed-stream", "The provider stream contained invalid JSON.", false);
  }
  if (error instanceof TypeError) {
    return failure("network", "The provider network request failed.", true);
  }
  return failure("adapter-defect", "The Google Gen AI SDK adapter failed unexpectedly.", false);
}

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

function cacheFor(
  options: GoogleGenAiSdkAdapterOptions,
  apiKey: string,
  request: CreateCachedContentParameters,
): Promise<CachedContent> {
  if (options.createCache !== undefined) {
    return options.createCache(apiKey, request);
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
  return client.caches.create(request);
}

type GooglePromptCacheResolution = {
  readonly name: string;
  readonly cacheWriteInputTokens: number;
};

const GOOGLE_PROMPT_CACHE_TTL_MS = 5 * 60 * 1_000;
const GOOGLE_PROMPT_CACHE_RETRY_MS = 30 * 1_000;
const MAX_GOOGLE_PROMPT_CACHE_ENTRIES = 64;

function usageFrom(response: GenerateContentResponse): UsageUnits | null {
  const usage = response.usageMetadata;
  if (usage === undefined) {
    return null;
  }
  const inputTokens = (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0);
  const outputTokens = usage.candidatesTokenCount ?? 0;
  return {
    provenance: "provider-reported",
    inputTokens,
    outputTokens,
    ...(usage.totalTokenCount === undefined ? {} : { totalTokens: usage.totalTokenCount }),
    ...(usage.cachedContentTokenCount === undefined
      ? {}
      : { cachedInputTokens: usage.cachedContentTokenCount }),
    ...(usage.thoughtsTokenCount === undefined
      ? {}
      : { reasoningTokens: usage.thoughtsTokenCount }),
  };
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
  const resolvedCompatibility = resolveProviderTransportCompatibilityPlan(
    "google",
    options.compatibility,
  );
  if (!resolvedCompatibility.ok) {
    throw new Error("Google Gen AI SDK adapter received an incompatible transport declaration");
  }
  const transportCompatibility = resolvedCompatibility.value;
  const identity = {
    providerId: providerId.from(options.providerId ?? "google"),
    profileId: options.profileId,
    adapterKind: "google" as const,
    endpoint: options.baseUrl ?? null,
    destinationId: providerDestinationId("google", options.baseUrl ?? null),
    transportCompatibilityId: transportCompatibility.compatibilityId,
    displayName: options.displayName ?? "Google",
  };
  const models = options.supportedModels.map((id) => modelId.from(id));
  const cacheEntries = new Map<
    string,
    { readonly name: string | null; readonly expiresAt: number }
  >();
  const pendingCaches = new Map<string, Promise<GooglePromptCacheResolution | null>>();

  const resolveExplicitCache = async (
    apiKey: string,
    request: ModelRequest,
    stable: ReturnType<typeof toGoogleMessages>,
    tools: Tool[] | undefined,
    signal: AbortSignal,
  ): Promise<GooglePromptCacheResolution | null> => {
    const policy = request.promptCache;
    if (policy === undefined || policy.mode !== "google-explicit-resource") {
      return null;
    }
    const now = Date.now();
    const existing = cacheEntries.get(policy.key);
    if (existing !== undefined && existing.expiresAt > now) {
      return existing.name === null ? null : { name: existing.name, cacheWriteInputTokens: 0 };
    }
    const pending = pendingCaches.get(policy.key);
    if (pending !== undefined) {
      const resolved = await pending;
      return resolved === null ? null : { name: resolved.name, cacheWriteInputTokens: 0 };
    }
    if (cacheEntries.size >= MAX_GOOGLE_PROMPT_CACHE_ENTRIES) {
      cacheEntries.clear();
    }
    const creation = (async (): Promise<GooglePromptCacheResolution | null> => {
      try {
        const cached = await cacheFor(options, apiKey, {
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
        });
        if (cached.name === undefined || cached.name.length === 0) {
          cacheEntries.set(policy.key, {
            name: null,
            expiresAt: now + GOOGLE_PROMPT_CACHE_RETRY_MS,
          });
          return null;
        }
        cacheEntries.set(policy.key, {
          name: cached.name,
          expiresAt: now + GOOGLE_PROMPT_CACHE_TTL_MS,
        });
        return {
          name: cached.name,
          cacheWriteInputTokens: cached.usageMetadata?.totalTokenCount ?? 0,
        };
      } catch {
        // Prompt caching is an optimization. Authentication, request, and
        // provider failures are still reported by the uncached generation.
        cacheEntries.set(policy.key, { name: null, expiresAt: now + GOOGLE_PROMPT_CACHE_RETRY_MS });
        return null;
      } finally {
        pendingCaches.delete(policy.key);
      }
    })();
    pendingCaches.set(policy.key, creation);
    return creation;
  };

  return {
    identity,
    supportedModels: models,
    requestInputModalities: ["text"],
    requestResponseDensityControls: [],
    transportCompatibility,
    async *stream(
      request: ModelRequest,
      streamOptions: ProviderStreamOptions,
    ): AsyncIterable<NormalizedProviderEvent> {
      const attempt = modelAttemptId.from(`attempt-${request.requestId}`);
      let sequence = 1;
      const next = (): number => sequence++;

      yield {
        kind: "request-started",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: next(),
      };

      if (streamOptions.signal.aborted) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure("cancellation", "The provider request was cancelled.", false),
        };
        return;
      }
      if (request.responseDensityControl !== null && request.responseDensityControl !== undefined) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure(
            "unsupported-capability",
            "This Google GenAI SDK route has no verified native response-density control.",
            false,
          ),
        };
        return;
      }

      let apiKey: string | null;
      try {
        apiKey = await options.resolveApiKey(streamOptions.signal);
      } catch (error) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: classifySdkError(error, streamOptions.signal),
        };
        return;
      }
      if (apiKey === null || apiKey.trim() === "") {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure(
            "authentication",
            "No provider credential is available for this profile.",
            false,
          ),
        };
        return;
      }

      let sdkRequest: GenerateContentParameters;
      let cacheWriteInputTokens: number | undefined;
      try {
        let translated = toGoogleMessages(request.messages);
        const tools = toTools(request.tools);
        const level = thinkingLevel(request.reasoningControl);
        let cachedContent: string | undefined;
        let requestTools = tools;
        if (request.promptCache !== undefined) {
          if (
            request.promptCache.mode !== "google-explicit-resource" &&
            request.promptCache.mode !== "implicit-prefix"
          ) {
            throw new GoogleInputError(
              "unsupported-capability",
              "The routed prompt-cache mechanism is incompatible with Google GenAI.",
            );
          }
          if (request.promptCache.mode === "google-explicit-resource") {
            const stableMessages = request.messages.slice(
              0,
              request.promptCache.stableMessageCount,
            );
            const dynamicMessages = request.messages.slice(request.promptCache.stableMessageCount);
            const stable = toGoogleMessages(stableMessages);
            const dynamic = toGoogleMessages(dynamicMessages);
            // Google forbids repeating system instructions and tools alongside
            // a cached-content reference. A later system message therefore
            // falls back to the exact implicit-prefix request.
            if (dynamic.systemInstruction === undefined && dynamic.contents.length > 0) {
              const resolved = await resolveExplicitCache(
                apiKey,
                request,
                stable,
                tools,
                streamOptions.signal,
              );
              if (resolved !== null) {
                translated = dynamic;
                cachedContent = resolved.name;
                cacheWriteInputTokens = resolved.cacheWriteInputTokens;
                requestTools = undefined;
              }
            }
          }
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
            ...(level === undefined ? {} : { thinkingConfig: { thinkingLevel: level } }),
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
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: classifySdkError(error, streamOptions.signal),
        };
        return;
      }

      const toolCalls = new Map<string, ToolCallState>();
      let finishReason: string | null = null;
      let finalUsage: UsageUnits | null = null;
      let safetyBlocked = false;
      let invalidToolCall = false;

      try {
        const stream = await streamFor(options, apiKey, sdkRequest);
        for await (const chunk of stream) {
          finalUsage = usageFrom(chunk) ?? finalUsage;
          if (chunk.promptFeedback?.blockReason !== undefined) {
            safetyBlocked = true;
          }
          for (const candidate of chunk.candidates ?? []) {
            const candidateIndex = candidate.index ?? 0;
            const reason = candidate.finishReason;
            if (reason !== undefined && reason !== "FINISH_REASON_UNSPECIFIED") {
              finishReason = reason;
              safetyBlocked ||= SAFETY_FINISH_REASONS.has(reason);
              invalidToolCall ||=
                reason === "MALFORMED_FUNCTION_CALL" || reason === "UNEXPECTED_TOOL_CALL";
            }
            for (const [partIndex, part] of (candidate.content?.parts ?? []).entries()) {
              if (typeof part.text === "string" && part.text.length > 0) {
                yield {
                  kind: part.thought === true ? "reasoning-delta" : "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: part.text,
                };
              }
              const call = part.functionCall;
              if (call?.name !== undefined) {
                const id = call.id ?? `tool-${candidateIndex}-${partIndex}`;
                const argumentsJson = JSON.stringify(call.args ?? {});
                toolCalls.set(id, { id, name: call.name, argumentsJson });
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
            }
          }
        }
      } catch (error) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: classifySdkError(error, streamOptions.signal),
        };
        return;
      }

      if (streamOptions.signal.aborted) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure("cancellation", "The provider request was cancelled.", false),
        };
        return;
      }
      for (const tool of toolCalls.values()) {
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
      if (safetyBlocked) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure("provider-safety", "The provider blocked this request.", false),
        };
        return;
      }
      if (invalidToolCall) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure("invalid-request", "The provider returned an invalid tool call.", false),
        };
        return;
      }
      if (finishReason === null) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure(
            "malformed-stream",
            "The provider stream ended without a terminal event.",
            false,
          ),
        };
        return;
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
