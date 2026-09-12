import type {
  ContentBlockParam,
  MessageParam,
  TextBlockParam,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { AnthropicMessagesTransportCompatibilityDeclaration } from "../../../providers/configuration/transport-compatibility.ts";
import type { ModelMessage, ModelToolDefinition } from "../../../providers/protocol/messages.ts";
import type { ModelRequest } from "../../../providers/protocol/request.ts";
import type { RetainedContinuation, RetainedThinkingBlock } from "./contracts.ts";
import { AnthropicInputError } from "./errors.ts";

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

export function anthropicReasoningEffort(
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

export function assistantToolCallIds(messages: readonly ModelMessage[]): readonly string[] {
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

export function toAnthropicMessages(
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

export function toTools(
  tools: readonly ModelToolDefinition[],
  compatibility: AnthropicMessagesTransportCompatibilityDeclaration,
): ToolUnion[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  const translated: ToolUnion[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { ...tool.parameters, type: "object" },
    strict: compatibility.strictToolSchemas,
    ...(tool.deferred === true ? { defer_loading: true } : {}),
  }));
  if (tools.some((tool) => tool.deferred === true)) {
    translated.push({
      name: "tool_search_tool_bm25",
      type: "tool_search_tool_bm25_20251119",
    });
  }
  return translated;
}
