/**
 * OpenAI SDK Chat Completions adapter.
 *
 * Falryn owns the provider-neutral request, event, policy, and retry contracts.
 * The official SDK owns authentication headers, HTTP execution, SSE decoding,
 * and endpoint transport inside this leaf adapter.
 */

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

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import type { ProviderFailure, ProviderFailureKind } from "../providers/errors.ts";
import type { ModelMessage, ModelToolDefinition } from "../providers/messages.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";

export type OpenAiSdkFetch = NonNullable<ClientOptions["fetch"]>;

export type OpenAiSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  /** OpenAI API base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** Resolve the credential for one request without putting it in configuration or events. */
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly fetch?: OpenAiSdkFetch;
  readonly supportedModels?: readonly string[];
  readonly organization?: string | null;
  readonly project?: string | null;
  readonly requestTimeoutMs?: number;
};

type ToolCallState = {
  id: string;
  name: string;
  arguments: string;
};

function failure(kind: ProviderFailureKind, message: string, retryable: boolean): ProviderFailure {
  return { kind, message, retryable };
}

function textOf(message: ModelMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

function toChatMessages(messages: readonly ModelMessage[]): OpenAI.ChatCompletionMessageParam[] {
  const translated: OpenAI.ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        continue;
      }
      translated.push({
        role: "tool",
        content: textOf(message),
        tool_call_id: message.toolCallId,
      });
      continue;
    }
    if (message.role === "assistant") {
      translated.push({
        role: "assistant",
        content: textOf(message) || null,
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.toolCallId,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }),
      });
      continue;
    }
    translated.push({ role: message.role, content: textOf(message) });
  }
  return translated;
}

function toTools(tools: readonly ModelToolDefinition[]): OpenAI.ChatCompletionTool[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function classifySdkError(error: unknown, signal: AbortSignal): ProviderFailure {
  if (signal.aborted || error instanceof APIUserAbortError) {
    return failure("cancellation", "The provider request was cancelled.", false);
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
  return failure("adapter-defect", "The OpenAI SDK adapter failed unexpectedly.", false);
}

function clientFor(options: OpenAiSdkAdapterOptions, apiKey: string): OpenAI {
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

function usageEvent(
  chunk: OpenAI.ChatCompletionChunk,
  request: ModelRequest,
  attempt: ReturnType<typeof modelAttemptId.from>,
  sequence: number,
): NormalizedProviderEvent | null {
  const usage = chunk.usage;
  if (usage === null || usage === undefined) {
    return null;
  }
  return {
    kind: "usage",
    requestId: request.requestId,
    modelAttemptId: attempt,
    sequence,
    usage: {
      provenance: "provider-reported",
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      ...(usage.prompt_tokens_details?.cached_tokens === undefined
        ? {}
        : { cachedInputTokens: usage.prompt_tokens_details.cached_tokens }),
      ...(usage.completion_tokens_details?.reasoning_tokens === undefined
        ? {}
        : { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }),
    },
  };
}

function completeToolProposals(
  toolCalls: ReadonlyMap<number, ToolCallState>,
): readonly ToolCallState[] {
  return [...toolCalls.values()].filter((tool) => tool.name.length > 0);
}

/** Create a live SDK-backed Chat Completions adapter. */
export function createOpenAiSdkAdapter(options: OpenAiSdkAdapterOptions): ProviderAdapterPort {
  const identity = {
    providerId: providerId.from(options.providerId ?? "openai"),
    profileId: options.profileId,
    displayName: options.displayName ?? "OpenAI",
  };
  const models = (options.supportedModels ?? ["gpt-4o-mini"]).map((id) => modelId.from(id));

  return {
    identity,
    supportedModels: models,
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

      const tools = toTools(request.tools);
      const body: OpenAI.ChatCompletionCreateParamsStreaming = {
        model: String(request.modelId),
        stream: true,
        stream_options: { include_usage: true },
        messages: toChatMessages(request.messages),
        ...(tools === undefined ? {} : { tools }),
        ...(request.budgets.maxOutputTokens === undefined
          ? {}
          : { max_tokens: request.budgets.maxOutputTokens }),
      };

      const toolCalls = new Map<number, ToolCallState>();
      let finishReason: string | null = null;
      let proposalsEmitted = false;

      try {
        const stream = await clientFor(options, apiKey).chat.completions.create(body, {
          signal: streamOptions.signal,
        });
        for await (const chunk of stream) {
          const usage = usageEvent(chunk, request, attempt, sequence);
          if (usage !== null) {
            sequence += 1;
            yield usage;
          }

          const choice = chunk.choices[0];
          if (choice === undefined) {
            continue;
          }
          const { delta } = choice;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield {
              kind: "text-delta",
              requestId: request.requestId,
              modelAttemptId: attempt,
              sequence: next(),
              text: delta.content,
            };
          }
          const reasoning = Reflect.get(delta, "reasoning_content");
          if (typeof reasoning === "string" && reasoning.length > 0) {
            yield {
              kind: "reasoning-delta",
              requestId: request.requestId,
              modelAttemptId: attempt,
              sequence: next(),
              text: reasoning,
            };
          }
          for (const item of delta.tool_calls ?? []) {
            const existing = toolCalls.get(item.index) ?? { id: "", name: "", arguments: "" };
            if (item.id !== undefined && item.id.length > 0) {
              existing.id = item.id;
            }
            if (item.function?.name !== undefined && item.function.name.length > 0) {
              existing.name = item.function.name;
            }
            const fragment = item.function?.arguments;
            if (fragment !== undefined && fragment.length > 0) {
              existing.arguments += fragment;
              yield {
                kind: "tool-call-delta",
                requestId: request.requestId,
                modelAttemptId: attempt,
                sequence: next(),
                toolCallId: existing.id || `tool-${item.index}`,
                ...(existing.name.length === 0 ? {} : { name: existing.name }),
                argumentsFragment: fragment,
              };
            }
            if (existing.id.length === 0) {
              existing.id = `tool-${item.index}`;
            }
            toolCalls.set(item.index, existing);
          }

          if (typeof choice.finish_reason === "string") {
            finishReason = choice.finish_reason;
            if (!proposalsEmitted) {
              for (const tool of completeToolProposals(toolCalls)) {
                yield {
                  kind: "tool-proposal",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  toolCallId: tool.id,
                  name: tool.name,
                  argumentsJson: tool.arguments,
                };
              }
              proposalsEmitted = true;
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
