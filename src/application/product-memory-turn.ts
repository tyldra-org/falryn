/**
 * Product memory turn-end admission and recall (#720).
 *
 * Runs a bounded admit of the turn task text and recalls matching records for
 * the next prompt's memory section. Does not invent secrets or bypass policy.
 */

import {
  err,
  ok,
  type PromptSectionInput,
  type Result,
  type SessionId,
  type TurnId,
  timestampFromEpochMilliseconds,
  type WorkspaceId,
} from "../domain/index.ts";
import type { MemoryAdmissionPort } from "./memory-admission.ts";
import type { MemoryRecallPort } from "./memory-recall.ts";
import { PRODUCT_MEMORY_TOOLS_OWNER } from "./product-tools-memory.ts";

export type ProductMemoryTurnPorts = {
  readonly admission: MemoryAdmissionPort;
  readonly recall: MemoryRecallPort;
};

export type ProductMemoryTurnResult = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  readonly admittedId: string | null;
  readonly memorySection: PromptSectionInput | null;
  readonly recalledCount: number;
};

export type ProductMemoryTurn = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  endTurn(input: {
    readonly turnId: TurnId;
    readonly sessionId: SessionId;
    readonly workspaceId: WorkspaceId;
    readonly task: string;
  }): Result<ProductMemoryTurnResult, { readonly code: string }>;
};

/**
 * Compose turn-end memory admission and recall for live prompts.
 */
export function composeProductMemoryTurn(ports: ProductMemoryTurnPorts): ProductMemoryTurn {
  return {
    owner: PRODUCT_MEMORY_TOOLS_OWNER,
    endTurn(input) {
      const id = `mem-${String(input.turnId)}`;
      const now = timestampFromEpochMilliseconds(Date.now());
      const admitted = ports.admission.admit(
        {
          memoryId: id,
          scope: { kind: "workspace", workspaceId: String(input.workspaceId) },
          kind: "project-fact",
          subject: `turn:${String(input.turnId)}`,
          content: input.task.slice(0, 2_048),
          provenance: [{ origin: "user-request", locator: String(input.turnId) }],
          confidence: 70,
          createdAt: now,
        },
        {
          sourceKind: "user",
          sourceTrust: "user-confirmed",
          workspaceId: String(input.workspaceId),
        },
      );
      if (!admitted.ok) {
        return err({ code: admitted.error.code });
      }

      const recalled = ports.recall.recall({
        workspaceId: String(input.workspaceId),
        now,
        maxResults: 8,
      });
      if (!recalled.ok) {
        return err({ code: recalled.error.code });
      }

      const lines = recalled.value.selected.map(
        (hit) => `- ${hit.record.subject}: ${hit.record.content.slice(0, 240)}`,
      );
      const memorySection: PromptSectionInput | null =
        lines.length === 0
          ? null
          : {
              id: "memory",
              role: "memory",
              source: `memory:${PRODUCT_MEMORY_TOOLS_OWNER}`,
              content: lines.join("\n"),
              required: false,
              available: true,
            };

      return ok({
        owner: PRODUCT_MEMORY_TOOLS_OWNER,
        admittedId: id,
        memorySection,
        recalledCount: recalled.value.selected.length,
      });
    },
  };
}
