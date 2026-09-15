/** Admit the complete neutral request on every route and tool continuation. */
import { HARD_CONTEXT_MAX_TOTAL_TOKENS } from "../../domain/context/context-budget.ts";
import { HISTORY_LIMITS } from "../../domain/sessions/history.ts";
import type { ModelBudgets, ModelMessage, ModelToolDefinition } from "../../providers/index.ts";

export function conversationBudget(
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDefinition[],
  budgets: ModelBudgets,
  capability:
    | { readonly contextTokens?: number | null; readonly outputTokens?: number | null }
    | undefined,
) {
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }));
  const inputTokens = Math.ceil(bytes / 4);
  const window = Math.min(capability?.contextTokens ?? 0, HARD_CONTEXT_MAX_TOTAL_TOKENS);
  const outputTokens = Math.min(
    budgets.maxOutputTokens ?? capability?.outputTokens ?? 0,
    capability?.outputTokens ?? 0,
  );
  const reason = messages.some((message) => message.parts.some((part) => part.kind !== "text"))
    ? "modality-budget-unavailable"
    : window <= 0 || outputTokens <= 0
      ? "model-budget-unavailable"
      : bytes > HISTORY_LIMITS.contentBytes
        ? "request-byte-limit"
        : inputTokens > (budgets.maxInputTokens ?? window) ||
            inputTokens + 2 * outputTokens > window
          ? "insufficient-budget"
          : null;
  return {
    kind: "utf8-bytes-divided-by-four" as const,
    bytes,
    inputTokens,
    outputTokens,
    continuationTokens: outputTokens,
    window,
    reason,
  };
}
