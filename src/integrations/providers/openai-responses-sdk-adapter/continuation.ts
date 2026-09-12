import type { ResponseReasoningItem } from "openai/resources/responses/responses";
import { z } from "zod";
import { PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION } from "../../../providers/protocol/continuation-state.ts";
import type { RetainedContinuation } from "./contracts.ts";

const searchSchema = z
  .array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("tool_search_call"),
        id: z.string().min(1),
        arguments: z.unknown(),
        call_id: z.string().nullable(),
        execution: z.literal("server"),
        status: z.literal("completed"),
        created_by: z.string().optional(),
      }),
      z.object({
        type: z.literal("tool_search_output"),
        id: z.string().min(1),
        call_id: z.string().nullable(),
        execution: z.literal("server"),
        status: z.literal("completed"),
        created_by: z.string().optional(),
        tools: z
          .array(
            z.object({
              type: z.literal("function"),
              name: z.string().min(1),
              description: z.string().nullable().optional(),
              parameters: z.record(z.string(), z.unknown()),
              strict: z.boolean().nullable().optional(),
              defer_loading: z.boolean().optional(),
            }),
          )
          .max(128),
      }),
    ]),
  )
  .max(128);

const MAX_RETAINED_TOOL_CALLS = 256;

export const MAX_CONTINUATION_STATE_JSON_LENGTH = 4 * 1024 * 1024;

export function retain(
  retained: Map<string, RetainedContinuation>,
  callId: string,
  value: RetainedContinuation,
): void {
  retained.delete(callId);
  retained.set(callId, value);
  while (retained.size > MAX_RETAINED_TOOL_CALLS) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    retained.delete(oldest);
  }
}

export function parseRetainedContinuation(stateJson: string): RetainedContinuation | null {
  if (stateJson.length === 0 || stateJson.length > MAX_CONTINUATION_STATE_JSON_LENGTH) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(stateJson) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION ||
    typeof record.responseId !== "string" ||
    record.responseId.length === 0 ||
    !Array.isArray(record.reasoning) ||
    record.reasoning.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        (item as Record<string, unknown>).type !== "reasoning" ||
        typeof (item as Record<string, unknown>).id !== "string" ||
        ((item as Record<string, unknown>).id as string).length === 0,
    )
  ) {
    return null;
  }
  const search = searchSchema.safeParse(record.search ?? []);
  if (!search.success) return null;
  const pending = new Set<string | null>();
  const identities = new Set<string>();
  for (const item of search.data) {
    if (identities.has(item.id)) return null;
    identities.add(item.id);
    if (item.type === "tool_search_call") {
      if (pending.has(item.call_id)) return null;
      pending.add(item.call_id);
    } else if (!pending.delete(item.call_id)) return null;
  }
  if (pending.size > 0) return null;

  return {
    search: search.data as NonNullable<RetainedContinuation["search"]>,
    responseId: record.responseId,
    reasoning: record.reasoning as ResponseReasoningItem[],
  };
}

export function continuationStateJson(value: RetainedContinuation): string {
  return JSON.stringify({
    schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
    responseId: value.responseId,
    reasoning: value.reasoning,
    search: value.search ?? [],
  });
}
