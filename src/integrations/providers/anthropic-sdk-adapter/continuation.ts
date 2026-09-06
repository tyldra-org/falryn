import type { RetainedContinuation, RetainedThinkingBlock } from "./contracts.ts";

const MAX_RETAINED_TOOL_CALLS = 256;

const MAX_RETAINED_THINKING_BLOCKS = 64;

export const MAX_CONTINUATION_STATE_JSON_LENGTH = 4 * 1024 * 1024;

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
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
    !hasOnlyKeys(parsed, ["thinking"]) ||
    !("thinking" in parsed) ||
    !Array.isArray(parsed.thinking) ||
    parsed.thinking.length > MAX_RETAINED_THINKING_BLOCKS
  ) {
    return null;
  }
  const thinking: RetainedThinkingBlock[] = [];
  for (const block of parsed.thinking) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      return null;
    }
    if (
      block.type === "thinking" &&
      "thinking" in block &&
      typeof block.thinking === "string" &&
      "signature" in block &&
      typeof block.signature === "string" &&
      block.signature.length > 0 &&
      hasOnlyKeys(block, ["type", "thinking", "signature"])
    ) {
      thinking.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      continue;
    }
    if (
      block.type === "redacted_thinking" &&
      "data" in block &&
      typeof block.data === "string" &&
      block.data.length > 0 &&
      hasOnlyKeys(block, ["type", "data"])
    ) {
      thinking.push({ type: "redacted_thinking", data: block.data });
      continue;
    }
    return null;
  }
  return { thinking };
}

export function continuationStateJson(value: RetainedContinuation): string {
  return JSON.stringify({ thinking: value.thinking });
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
      break;
    }
    retained.delete(oldest);
  }
}
