import { type Content, type Part, ThinkingLevel, type Tool } from "@google/genai";
import type { ModelMessage, ModelToolDefinition } from "../../../providers/protocol/messages.ts";
import type { RetainedContinuation, SignedThoughtPart } from "./contracts.ts";
import { GoogleInputError } from "./errors.ts";

export function thinkingLevel(control: string | null | undefined): ThinkingLevel | undefined {
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

function functionResponseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retainedForAssistant(
  message: ModelMessage,
  retained: ReadonlyMap<string, RetainedContinuation>,
): {
  readonly signedThoughts: readonly SignedThoughtPart[];
  readonly functionSignatures: ReadonlyMap<string, string>;
} {
  const records = (message.toolCalls ?? []).map((call) => ({
    toolCallId: call.toolCallId,
    record: retained.get(call.toolCallId),
  }));
  const present = records.filter(
    (entry): entry is { readonly toolCallId: string; readonly record: RetainedContinuation } =>
      entry.record !== undefined,
  );
  if (present.length === 0) {
    return { signedThoughts: [], functionSignatures: new Map() };
  }
  if (present.length !== records.length) {
    throw new GoogleInputError(
      "invalid-request",
      "A Google assistant turn has incomplete retained thought-signature state.",
    );
  }
  const canonicalThoughts = JSON.stringify(present[0]?.record.signedThoughts ?? []);
  if (present.some((entry) => JSON.stringify(entry.record.signedThoughts) !== canonicalThoughts)) {
    throw new GoogleInputError(
      "invalid-request",
      "Google function calls refer to conflicting retained thought state.",
    );
  }
  return {
    signedThoughts: present[0]?.record.signedThoughts ?? [],
    functionSignatures: new Map(
      present.flatMap((entry) =>
        entry.record.functionThoughtSignature === null
          ? []
          : [[entry.toolCallId, entry.record.functionThoughtSignature] as const],
      ),
    ),
  };
}

export function toGoogleMessages(
  messages: readonly ModelMessage[],
  retained: ReadonlyMap<string, RetainedContinuation>,
  options: { readonly allowSystemOnly?: boolean } = {},
): {
  readonly systemInstruction: string | undefined;
  readonly contents: Content[];
} {
  rejectImageParts(messages);
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystem < 0) {
    if (options.allowSystemOnly !== true || messages.length === 0) {
      throw new GoogleInputError(
        "invalid-request",
        "Google Generate Content requires at least one non-system message.",
      );
    }
    const systemInstruction = messages
      .map(textOf)
      .filter((text) => text.length > 0)
      .join("\n\n");
    if (systemInstruction.length === 0) {
      throw new GoogleInputError("invalid-request", "A Google system instruction cannot be empty.");
    }
    return { systemInstruction, contents: [] };
  }
  if (messages.slice(firstNonSystem + 1).some((message) => message.role === "system")) {
    throw new GoogleInputError(
      "invalid-request",
      "Google system instructions must form one leading prefix.",
    );
  }
  const systemInstruction = messages
    .slice(0, firstNonSystem)
    .map(textOf)
    .filter((text) => text.length > 0)
    .join("\n\n");
  const contents: Content[] = [];
  const pendingToolCalls = new Map<string, string>();
  const seenToolCalls = new Set<string>();
  let pendingToolResponses: Part[] = [];

  const flushToolResponses = (): void => {
    if (pendingToolResponses.length === 0) {
      return;
    }
    if (pendingToolCalls.size > 0) {
      throw new GoogleInputError(
        "invalid-request",
        "A Google model function turn is missing one or more function responses.",
      );
    }
    contents.push({ role: "user", parts: pendingToolResponses });
    pendingToolResponses = [];
  };

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
      const name = pendingToolCalls.get(message.toolCallId);
      if (name === undefined) {
        throw new GoogleInputError(
          "invalid-request",
          "A Google function response has no unmatched model function call.",
        );
      }
      pendingToolCalls.delete(message.toolCallId);
      pendingToolResponses.push({
        functionResponse: {
          id: message.toolCallId,
          name,
          response: { output: functionResponseValue(textOf(message)) },
        },
      });
      continue;
    }
    flushToolResponses();
    if (message.role === "assistant") {
      const replay = retainedForAssistant(message, retained);
      const parts: Part[] = replay.signedThoughts.map((part) => ({ ...part }));
      const text = textOf(message);
      if (text.length > 0) {
        parts.push({ text });
      }
      for (const call of message.toolCalls ?? []) {
        if (seenToolCalls.has(call.toolCallId)) {
          throw new GoogleInputError(
            "invalid-request",
            "A Google model message contains a duplicate function-call identity.",
          );
        }
        seenToolCalls.add(call.toolCallId);
        pendingToolCalls.set(call.toolCallId, call.name);
        const thoughtSignature = replay.functionSignatures.get(call.toolCallId);
        parts.push({
          functionCall: {
            id: call.toolCallId,
            name: call.name,
            args: { ...call.arguments },
          },
          ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
        });
      }
      if (parts.length === 0) {
        throw new GoogleInputError("invalid-request", "A Google model message cannot be empty.");
      }
      contents.push({ role: "model", parts });
      continue;
    }
    const text = textOf(message);
    if (text.length === 0) {
      throw new GoogleInputError("invalid-request", "A Google user message cannot be empty.");
    }
    contents.push({ role: "user", parts: [{ text }] });
  }

  flushToolResponses();
  if (pendingToolCalls.size > 0) {
    throw new GoogleInputError(
      "invalid-request",
      "A Google model function turn is missing one or more function responses.",
    );
  }

  return {
    systemInstruction: systemInstruction.length === 0 ? undefined : systemInstruction,
    contents,
  };
}

export function toTools(tools: readonly ModelToolDefinition[]): Tool[] | undefined {
  // Generate Content has no deferred-definition transport; deferred tools stay
  // omitted so the wire matches ordinary bounded disclosure.
  const eager = tools.filter((tool) => tool.deferred !== true);
  if (eager.length === 0) {
    return undefined;
  }
  return [
    {
      functionDeclarations: eager.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersJsonSchema: tool.parameters,
      })),
    },
  ];
}

export function assistantToolCallIds(messages: readonly ModelMessage[]): readonly string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const call of message.toolCalls ?? []) {
      ids.add(call.toolCallId);
    }
  }
  return [...ids];
}

export function definedPartPayloadKeys(part: Part): readonly string[] {
  const keys = [
    "toolCall",
    "toolResponse",
    "audioTranscription",
    "codeExecutionResult",
    "executableCode",
    "fileData",
    "functionCall",
    "functionResponse",
    "inlineData",
    "text",
    "videoMetadata",
    "partMetadata",
    "mediaProcessing",
  ] as const;
  return keys.filter((key) => part[key] !== undefined);
}
