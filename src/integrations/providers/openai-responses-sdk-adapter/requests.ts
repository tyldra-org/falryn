import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  Tool,
} from "openai/resources/responses/responses";

import type { OpenAiResponsesTransportCompatibilityDeclaration } from "../../../providers/configuration/transport-compatibility.ts";
import type { ModelMessage, ModelToolDefinition } from "../../../providers/protocol/messages.ts";
import type { ModelRequest } from "../../../providers/protocol/request.ts";
import type { RetainedContinuation } from "./contracts.ts";
import { OpenAiResponsesInputError } from "./errors.ts";
import { responsesToolSchema } from "./tool-schema.ts";

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
): Tool[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  const translated: Tool[] = tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: compatibility.strictToolSchemas
      ? responsesToolSchema(tool.parameters).schema
      : tool.parameters,
    strict: compatibility.strictToolSchemas,
    ...(tool.deferred === true ? { defer_loading: true } : {}),
  }));
  if (tools.some((tool) => tool.deferred === true)) {
    translated.push({ type: "tool_search", execution: "server" });
  }
  return translated;
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
  tools: readonly ModelToolDefinition[],
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
        const definition = tools.find((tool) => tool.name === call.name);
        input.push({
          type: "function_call",
          call_id: call.toolCallId,
          name: call.name,
          arguments: JSON.stringify(
            compatibility.strictToolSchemas && definition
              ? responsesToolSchema(definition.parameters).encode(call.arguments)
              : call.arguments,
          ),
        });
      }
      continue;
    }
    input.push({ role: "user", content: textOf(message) });
  }
  return { input, previousResponseId: prior?.responseId ?? null };
}

export function responseBody(
  request: ModelRequest,
  compatibility: OpenAiResponsesTransportCompatibilityDeclaration,
  retained: ReadonlyMap<string, RetainedContinuation>,
): ResponseCreateParamsStreaming {
  const translated = toInput(request.messages, compatibility, retained, request.tools);
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

export function assistantToolCallIds(messages: readonly ModelMessage[]): readonly string[] {
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
