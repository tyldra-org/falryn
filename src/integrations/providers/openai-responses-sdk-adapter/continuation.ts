import type { ResponseReasoningItem } from "openai/resources/responses/responses";
import { PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION } from "../../../providers/protocol/continuation-state.ts";
import type { RetainedContinuation } from "./contracts.ts";

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
  return {
    responseId: record.responseId,
    reasoning: record.reasoning as ResponseReasoningItem[],
  };
}

export function continuationStateJson(value: RetainedContinuation): string {
  return JSON.stringify({
    schemaVersion: PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION,
    responseId: value.responseId,
    reasoning: value.reasoning,
  });
}
