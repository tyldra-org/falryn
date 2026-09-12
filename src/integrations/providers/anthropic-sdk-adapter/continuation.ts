import { z } from "zod";
import type { RetainedContinuation, RetainedThinkingBlock } from "./contracts.ts";

const searchSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("server_tool_use"),
        id: z.string().min(1),
        name: z.enum(["tool_search_tool_bm25", "tool_search_tool_regex"]),
        input: z.unknown(),
      }),
      z.object({
        type: z.literal("tool_search_tool_result"),
        tool_use_id: z.string().min(1),
        content: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("tool_search_tool_search_result"),
            tool_references: z
              .array(z.object({ type: z.literal("tool_reference"), tool_name: z.string().min(1) }))
              .max(128),
          }),
          z.object({
            type: z.literal("tool_search_tool_result_error"),
            error_code: z.enum([
              "invalid_tool_input",
              "unavailable",
              "too_many_requests",
              "execution_time_exceeded",
            ]),
            error_message: z.string().nullable().optional(),
          }),
        ]),
      }),
    ]),
  )
  .max(128);

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
    !hasOnlyKeys(parsed, ["thinking", "search"]) ||
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
  const search = searchSchema.safeParse("search" in parsed ? parsed.search : []);
  if (!search.success) return null;
  const pending = new Set<string | null>();
  const identities = new Set<string>();
  for (const item of search.data) {
    if (item.type === "server_tool_use") {
      if (identities.has(item.id)) return null;
      identities.add(item.id);
      pending.add(item.id);
    } else if (!pending.delete(item.tool_use_id)) return null;
  }
  if (pending.size > 0) return null;

  return { thinking, search: search.data as NonNullable<RetainedContinuation["search"]> };
}

export function continuationStateJson(value: RetainedContinuation): string {
  return JSON.stringify({ thinking: value.thinking, search: value.search ?? [] });
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
