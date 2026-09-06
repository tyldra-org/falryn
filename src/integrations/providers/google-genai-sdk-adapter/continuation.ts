import type { RetainedContinuation, SignedThoughtPart } from "./contracts.ts";

const MAX_RETAINED_TOOL_CALLS = 256;

export const MAX_RETAINED_THOUGHT_PARTS = 64;

export const MAX_RETAINED_TEXT_LENGTH = 1024 * 1024;

export const MAX_CONTINUATION_STATE_JSON_LENGTH = 4 * 1024 * 1024;

function hasOnlyKeys(value: object, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseRetainedContinuation(stateJson: string): RetainedContinuation | null {
  if (stateJson.length === 0 || stateJson.length > MAX_CONTINUATION_STATE_JSON_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson) as unknown;
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !hasOnlyKeys(parsed, ["signedThoughts", "functionThoughtSignature"]) ||
    !("signedThoughts" in parsed) ||
    !Array.isArray(parsed.signedThoughts) ||
    parsed.signedThoughts.length > MAX_RETAINED_THOUGHT_PARTS ||
    !("functionThoughtSignature" in parsed) ||
    (parsed.functionThoughtSignature !== null &&
      (typeof parsed.functionThoughtSignature !== "string" ||
        parsed.functionThoughtSignature.length === 0 ||
        parsed.functionThoughtSignature.length > MAX_RETAINED_TEXT_LENGTH))
  ) {
    return null;
  }
  const signedThoughts: SignedThoughtPart[] = [];
  let retainedTextLength = 0;
  for (const value of parsed.signedThoughts) {
    if (
      typeof value !== "object" ||
      value === null ||
      !hasOnlyKeys(value, ["text", "thought", "thoughtSignature"]) ||
      !("text" in value) ||
      typeof value.text !== "string" ||
      !("thought" in value) ||
      value.thought !== true ||
      !("thoughtSignature" in value) ||
      typeof value.thoughtSignature !== "string" ||
      value.thoughtSignature.length === 0
    ) {
      return null;
    }
    retainedTextLength += value.text.length + value.thoughtSignature.length;
    if (retainedTextLength > MAX_RETAINED_TEXT_LENGTH) {
      return null;
    }
    signedThoughts.push({
      text: value.text,
      thought: true,
      thoughtSignature: value.thoughtSignature,
    });
  }
  return {
    signedThoughts,
    functionThoughtSignature: parsed.functionThoughtSignature,
  };
}

export function continuationStateJson(value: RetainedContinuation): string {
  return JSON.stringify({
    signedThoughts: value.signedThoughts,
    functionThoughtSignature: value.functionThoughtSignature,
  });
}

export function retain(
  retained: Map<string, RetainedContinuation>,
  toolCallId: string,
  value: RetainedContinuation,
): void {
  retained.delete(toolCallId);
  retained.set(toolCallId, value);
  while (retained.size > MAX_RETAINED_TOOL_CALLS) {
    const oldest = retained.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    retained.delete(oldest);
  }
}
