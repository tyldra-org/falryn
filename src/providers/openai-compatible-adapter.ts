/**
 * OpenAI-compatible chat Completions adapter (#709).
 *
 * Live HTTP leaf over Bun/`fetch` (TECH-STACK allows a Falryn fetch adapter for
 * compatible endpoints). Translates {@link ModelRequest} into the chat
 * completions JSON body, streams SSE deltas into {@link NormalizedProviderEvent},
 * and classifies disconnect / rate-limit / auth / malformed outcomes without
 * echoing secrets or raw provider payloads into failure messages.
 *
 * Does not execute tools, write sessions, or invent usage zeros.
 */

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import type { ProviderFailure, ProviderFailureKind } from "./errors.ts";
import type { ModelMessage, ModelToolDefinition } from "./messages.ts";
import type { ProviderAdapterPort, ProviderStreamOptions } from "./port.ts";
import type { ModelRequest } from "./request.ts";
import type { NormalizedProviderEvent } from "./stream.ts";

export type OpenAiCompatibleFetch = (input: string, init: RequestInit) => Promise<Response>;

export type OpenAiCompatibleAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  /** Base URL without trailing slash (e.g. `https://api.openai.com/v1`). */
  readonly baseUrl: string;
  /**
   * Resolves the bearer token for one request. The secret must not be logged.
   * Returning null/empty fails closed as authentication.
   */
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly fetch?: OpenAiCompatibleFetch;
  readonly supportedModels?: readonly string[];
};

type ChatMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
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

function toChatMessages(messages: readonly ModelMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        content: textOf(message),
        ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      out.push({
        role: "assistant",
        content: textOf(message) || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.toolCallId,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      });
      continue;
    }
    out.push({
      role: message.role,
      content: textOf(message),
    });
  }
  return out;
}

function toTools(
  tools: readonly ModelToolDefinition[],
): readonly Record<string, unknown>[] | undefined {
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

function classifyHttpStatus(status: number): ProviderFailure {
  if (status === 401) {
    return failure("authentication", "The provider rejected the credentials.", false);
  }
  if (status === 403) {
    return failure("authorization", "The provider denied this request.", false);
  }
  if (status === 429) {
    return failure("rate-limit", "The provider rate-limited this request.", true);
  }
  if (status === 400) {
    return failure("invalid-request", "The provider rejected the request shape.", false);
  }
  if (status >= 500) {
    return failure("server-failure", "The provider returned a server failure.", true);
  }
  return failure("server-failure", "The provider returned an unexpected status.", true);
}

function classifyFetchError(error: unknown, signal: AbortSignal): ProviderFailure {
  if (signal.aborted) {
    return failure("cancellation", "The provider request was cancelled.", false);
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "TimeoutError" || /timeout/i.test(message)) {
    return failure("timeout", "The provider request timed out.", true);
  }
  if (name === "AbortError") {
    return failure("cancellation", "The provider request was cancelled.", false);
  }
  return failure("network", "The provider network request failed.", true);
}

/**
 * Create a live OpenAI-compatible chat Completions streaming adapter.
 */
export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleAdapterOptions,
): ProviderAdapterPort {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const identity = {
    providerId: providerId.from(options.providerId ?? "openai-compatible"),
    profileId: options.profileId,
    displayName: options.displayName ?? "OpenAI-compatible",
  };
  const models = (options.supportedModels ?? ["gpt-4o-mini"]).map((id) => modelId.from(id));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

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
          failure: classifyFetchError(error, streamOptions.signal),
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

      const body: Record<string, unknown> = {
        model: String(request.modelId),
        stream: true,
        messages: toChatMessages(request.messages),
      };
      const tools = toTools(request.tools);
      if (tools !== undefined) {
        body.tools = tools;
      }
      if (request.budgets.maxOutputTokens !== undefined) {
        body.max_tokens = request.budgets.maxOutputTokens;
      }

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal: streamOptions.signal,
        });
      } catch (error) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: classifyFetchError(error, streamOptions.signal),
        };
        return;
      }

      if (!response.ok) {
        // Drain without retaining body text in the failure message.
        try {
          await response.arrayBuffer();
        } catch {
          // ignore
        }
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: classifyHttpStatus(response.status),
        };
        return;
      }

      if (response.body === null) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: failure("malformed-stream", "The provider returned an empty body.", false),
        };
        return;
      }

      const toolCalls = new Map<number, ToolCallState>();
      let sawFinished = false;
      let buffer = "";

      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
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
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            if (line.length === 0 || line.startsWith(":")) {
              continue;
            }
            if (!line.startsWith("data:")) {
              continue;
            }
            const data = line.slice("data:".length).trim();
            if (data === "[DONE]") {
              for (const tool of toolCalls.values()) {
                if (tool.name.length > 0) {
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
              }
              yield {
                kind: "finished",
                requestId: request.requestId,
                modelAttemptId: attempt,
                sequence: next(),
                finishReason: "stop",
              };
              sawFinished = true;
              return;
            }

            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              yield {
                kind: "error",
                requestId: request.requestId,
                modelAttemptId: attempt,
                sequence: next(),
                failure: failure(
                  "malformed-stream",
                  "The provider stream contained invalid JSON.",
                  false,
                ),
              };
              return;
            }

            if (typeof parsed !== "object" || parsed === null) {
              yield {
                kind: "error",
                requestId: request.requestId,
                modelAttemptId: attempt,
                sequence: next(),
                failure: failure(
                  "malformed-stream",
                  "The provider stream contained a non-object event.",
                  false,
                ),
              };
              return;
            }

            const choices = Reflect.get(parsed, "choices");
            if (!Array.isArray(choices) || choices.length === 0) {
              continue;
            }
            const choice = choices[0];
            if (typeof choice !== "object" || choice === null) {
              continue;
            }
            const delta = Reflect.get(choice, "delta");
            const finishReason = Reflect.get(choice, "finish_reason");

            if (typeof delta === "object" && delta !== null) {
              const content = Reflect.get(delta, "content");
              if (typeof content === "string" && content.length > 0) {
                yield {
                  kind: "text-delta",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  text: content,
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
              const toolCallDeltas = Reflect.get(delta, "tool_calls");
              if (Array.isArray(toolCallDeltas)) {
                for (const item of toolCallDeltas) {
                  if (typeof item !== "object" || item === null) {
                    continue;
                  }
                  const indexRaw = Reflect.get(item, "index");
                  const index = typeof indexRaw === "number" ? indexRaw : 0;
                  const existing = toolCalls.get(index) ?? {
                    id: "",
                    name: "",
                    arguments: "",
                  };
                  const id = Reflect.get(item, "id");
                  if (typeof id === "string" && id.length > 0) {
                    existing.id = id;
                  }
                  const fn = Reflect.get(item, "function");
                  if (typeof fn === "object" && fn !== null) {
                    const name = Reflect.get(fn, "name");
                    if (typeof name === "string" && name.length > 0) {
                      existing.name = name;
                    }
                    const args = Reflect.get(fn, "arguments");
                    if (typeof args === "string" && args.length > 0) {
                      existing.arguments += args;
                      yield {
                        kind: "tool-call-delta",
                        requestId: request.requestId,
                        modelAttemptId: attempt,
                        sequence: next(),
                        toolCallId: existing.id.length > 0 ? existing.id : `tool-${index}`,
                        name: existing.name.length > 0 ? existing.name : undefined,
                        argumentsFragment: args,
                      };
                    }
                  }
                  if (existing.id.length === 0) {
                    existing.id = `tool-${index}`;
                  }
                  toolCalls.set(index, existing);
                }
              }
            }

            if (typeof finishReason === "string" && finishReason.length > 0) {
              for (const tool of toolCalls.values()) {
                if (tool.name.length > 0) {
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
              }
              const usage = Reflect.get(parsed, "usage");
              if (typeof usage === "object" && usage !== null) {
                const inputTokens = Reflect.get(usage, "prompt_tokens");
                const outputTokens = Reflect.get(usage, "completion_tokens");
                yield {
                  kind: "usage",
                  requestId: request.requestId,
                  modelAttemptId: attempt,
                  sequence: next(),
                  usage: {
                    provenance: "provider-reported",
                    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
                    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
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
              sawFinished = true;
              return;
            }
          }
        }
      } catch (error) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: next(),
          failure: classifyFetchError(error, streamOptions.signal),
        };
        return;
      }

      if (!sawFinished) {
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
      }
    },
  };
}
