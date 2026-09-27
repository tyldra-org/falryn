/**
 * Answer MCP form input requests through the local user question owner (#1154).
 *
 * One elicitation becomes one structured question. An answer that does not satisfy the
 * requested schema is asked again with the reason, never sent. Refusal declines; expiry,
 * cancellation and a missing presenter cancel. Each question waits no longer than the call
 * has left, keeping room for the retry that carries the answer.
 */
import { MCP_DEADLINE_MS } from "../../domain/extensions/mcp.ts";
import {
  MCP_INPUT_LIMITS,
  type McpFormRequest,
  type McpInputDisposition,
  type McpInputResponse,
  mcpFormContent,
  mcpFormItems,
} from "../../domain/extensions/mcp-input.ts";
import type { QuestionOwner } from "../../domain/orchestration/question.ts";
import type { LocalUserQuestions } from "../orchestration/local-user-questions.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";

export type McpInputAnswer = {
  readonly response: McpInputResponse;
  readonly disposition: McpInputDisposition;
};
/** Ask for one form request on behalf of one tool call. */
export type McpInputAsk = (request: {
  readonly form: McpFormRequest;
  readonly serverId: string;
  readonly toolName: string;
  /** When the whole call must be finished. */
  readonly deadline: number;
  readonly signal: AbortSignal;
}) => Promise<McpInputAnswer>;
/** The asking scope of one tool call: its owner lineage and resource task. */
export type McpInputScope = {
  readonly owner: QuestionOwner;
  readonly resources: ProductTaskResources;
};
export type McpUserInput = (scope: McpInputScope) => McpInputAsk;

const CANCEL: McpInputResponse = { action: "cancel" };
const QUESTION_FLOOR_MS = 1000;

export function createMcpUserInput(
  local: Pick<LocalUserQuestions, "ask">,
  now: () => number = Date.now,
): McpUserInput {
  return (scope) =>
    async ({ form, serverId, toolName, deadline, signal }) => {
      let problem: string | null = null;
      for (let attempt = 0; attempt < MCP_INPUT_LIMITS.attempts; attempt++) {
        // Keep one request deadline for the retry that delivers the answer.
        const remaining = deadline - now() - MCP_DEADLINE_MS;
        if (remaining < QUESTION_FLOOR_MS) return { response: CANCEL, disposition: "timeout" };
        const settled = await local.ask({
          owner: scope.owner,
          resources: scope.resources,
          items: mcpFormItems(form, problem),
          waitMs: Math.min(MCP_INPUT_LIMITS.questionWaitMs, remaining),
          source: `${serverId} · ${toolName}`.slice(0, 128),
          signal,
        });
        if (settled.kind === "refused")
          return { response: { action: "decline" }, disposition: "decline" };
        if (settled.kind === "expired") return { response: CANCEL, disposition: "timeout" };
        if (settled.kind !== "answered") return { response: CANCEL, disposition: "cancel" };
        const content = mcpFormContent(form, settled.answer);
        if (content.ok)
          return {
            response: { action: "accept", content: content.content },
            disposition: "accept",
          };
        problem = content.problem;
      }
      return { response: CANCEL, disposition: "cancel" };
    };
}
