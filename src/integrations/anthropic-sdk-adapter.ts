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
  TextBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import type { ProviderFailure, ProviderFailureKind } from "../providers/errors.ts";
import type { ModelMessage, ModelToolDefinition } from "../providers/messages.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent, UsageUnits } from "../providers/stream.ts";
import { providerDestinationId } from "./provider-destination.ts";

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
};

type ToolCallState = {
  readonly id: string;
  readonly name: string;
  arguments: string;
};

class AnthropicInputError extends Error {
  readonly failureKind: ProviderFailureKind;

  constructor(failureKind: ProviderFailureKind, message: string) {
    super(message);
    this.name = "AnthropicInputError";
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

function toAnthropicMessages(
  messages: readonly ModelMessage[],
  promptCache: ModelRequest["promptCache"],
): {
  readonly system: string | TextBlockParam[] | undefined;
  readonly messages: MessageParam[];
} {
  rejectImageParts(messages);
  if (
    promptCache !== undefined &&
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
  const system =
    promptCache === undefined
      ? systemMessages.map((entry) => entry.text).join("\n\n")
      : systemMessages.map<TextBlockParam>((entry) => ({
          type: "text",
          text: entry.text,
          ...(entry.index === promptCache.stableMessageCount - 1
            ? { cache_control: { type: "ephemeral", ttl: "5m" } }
            : {}),
        }));
  const translated: MessageParam[] = [];

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
      translated.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: textOf(message),
          },
        ],
      });
      continue;
    }
    if (message.role === "assistant") {
      const content: ContentBlockParam[] = [];
      const text = textOf(message);
      if (text.length > 0) {
        content.push({ type: "text", text });
      }
      for (const call of message.toolCalls ?? []) {
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

  return { system: system.length === 0 ? undefined : system, messages: translated };
}

function toTools(tools: readonly ModelToolDefinition[]): Tool[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.parameters, type: "object" },
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
    return failure("rate-limit", "The provider rate-limited this request.", true);
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
): UsageUnits {
  const totalInputTokens = input.inputTokens + input.cacheCreationTokens + input.cacheReadTokens;
  return {
    provenance: "provider-reported",
    inputTokens: totalInputTokens,
    outputTokens,
    totalTokens: totalInputTokens + outputTokens,
    cachedInputTokens: input.cacheReadTokens,
    cacheWriteInputTokens: input.cacheCreationTokens,
  };
}

/** Create a live SDK-backed Anthropic Messages adapter. */
export function createAnthropicSdkAdapter(
  options: AnthropicSdkAdapterOptions,
): ProviderAdapterPort {
  const identity = {
    providerId: providerId.from(options.providerId ?? "anthropic"),
    profileId: options.profileId,
    adapterKind: "anthropic" as const,
    endpoint: options.baseUrl ?? null,
    destinationId: providerDestinationId("anthropic", options.baseUrl ?? null),
    displayName: options.displayName ?? "Anthropic",
  };
  const models = options.supportedModels.map((id) => modelId.from(id));

  return {
    identity,
    supportedModels: models,
    requestInputModalities: ["text"],
    requestResponseDensityControls: [],
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
            "This Anthropic SDK route has no verified native response-density control.",
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

      let body: MessageCreateParamsStreaming;
      try {
        const translated = toAnthropicMessages(request.messages, request.promptCache);
        const tools = toTools(request.tools);
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
          ...(Object.keys(outputConfig).length === 0 ? {} : { output_config: outputConfig }),
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

      const toolCalls = new Map<number, ToolCallState>();
      const emittedTools = new Set<number>();
      let finishReason: string | null = null;
      let inputUsage = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      let finalUsage: UsageUnits | null = null;
      let safetyBlocked = false;

      try {
        const stream = await streamFor(options, apiKey, body, streamOptions.signal);
        for await (const event of stream) {
          switch (event.type) {
            case "message_start": {
              const usage = event.message.usage;
              inputUsage = {
                inputTokens: usage.input_tokens,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              };
              break;
            }
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "text" && block.text.length > 0) {
                yield {
                  kind: "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: block.text,
                };
              } else if (block.type === "thinking" && block.thinking.length > 0) {
                yield {
                  kind: "reasoning-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: block.thinking,
                };
              } else if (block.type === "tool_use") {
                const initial = JSON.stringify(block.input);
                toolCalls.set(event.index, {
                  id: block.id,
                  name: block.name,
                  arguments: initial === "{}" ? "" : initial,
                });
              }
              break;
            }
            case "content_block_delta": {
              if (event.delta.type === "text_delta" && event.delta.text.length > 0) {
                yield {
                  kind: "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: event.delta.text,
                };
              } else if (event.delta.type === "thinking_delta" && event.delta.thinking.length > 0) {
                yield {
                  kind: "reasoning-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: event.delta.thinking,
                };
              } else if (
                event.delta.type === "input_json_delta" &&
                event.delta.partial_json.length > 0
              ) {
                const tool = toolCalls.get(event.index);
                if (tool === undefined) {
                  throw new AnthropicInputError(
                    "malformed-stream",
                    "The Anthropic stream emitted tool arguments before a tool call.",
                  );
                }
                tool.arguments += event.delta.partial_json;
                yield {
                  kind: "tool-call-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  toolCallId: tool.id,
                  name: tool.name,
                  argumentsFragment: event.delta.partial_json,
                };
              }
              break;
            }
            case "content_block_stop": {
              const tool = toolCalls.get(event.index);
              if (tool !== undefined && !emittedTools.has(event.index)) {
                yield {
                  kind: "tool-proposal",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  toolCallId: tool.id,
                  name: tool.name,
                  argumentsJson: tool.arguments.length === 0 ? "{}" : tool.arguments,
                };
                emittedTools.add(event.index);
              }
              break;
            }
            case "message_delta": {
              finishReason = event.delta.stop_reason;
              safetyBlocked = event.delta.stop_reason === "refusal";
              finalUsage = usageFrom(inputUsage, event.usage.output_tokens);
              break;
            }
            case "message_stop":
              break;
            default: {
              const exhaustive: never = event;
              throw new Error(`Unhandled Anthropic stream event: ${String(exhaustive)}`);
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
      if (finalUsage !== null) {
        yield {
          kind: "usage",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          usage: finalUsage,
        };
      }
      if (safetyBlocked) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure("provider-safety", "The provider refused this request.", false),
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
