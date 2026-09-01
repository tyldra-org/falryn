/** Product memory recall-before-prompt and terminal admission ordering (#788). */

import {
  err,
  ok,
  type PromptSectionInput,
  type Result,
  type TerminalOutcome,
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

export type ProductMemoryRecallResult = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  readonly memorySection: PromptSectionInput | null;
  readonly recalledCount: number;
};

export type ProductMemoryAdmissionResult = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  readonly admittedId: string | null;
  readonly admitted: boolean;
};

export type ProductMemoryTurn = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  recallBeforeTurn(input: {
    readonly workspaceId: WorkspaceId;
    readonly task: string;
    readonly signal?: AbortSignal;
  }): Result<ProductMemoryRecallResult, { readonly code: string }>;
  admitAfterTurn(input: {
    readonly turnId: TurnId;
    readonly workspaceId: WorkspaceId;
    readonly task: string;
    readonly outcome: TerminalOutcome;
    readonly signal?: AbortSignal;
  }): Result<ProductMemoryAdmissionResult, { readonly code: string }>;
};

/** Compose the memory lifecycle around the real terminal turn boundary. */
export function composeProductMemoryTurn(ports: ProductMemoryTurnPorts): ProductMemoryTurn {
  return {
    owner: PRODUCT_MEMORY_TOOLS_OWNER,
    recallBeforeTurn(input) {
      const recalled = ports.recall.recall(
        {
          workspaceId: String(input.workspaceId),
          query: input.task.slice(0, 256),
          now: timestampFromEpochMilliseconds(Date.now()),
          maxResults: 8,
        },
        input.signal,
      );
      if (!recalled.ok) {
        return err({ code: recalled.error.code });
      }

      const lines = recalled.value.selected.map(
        (hit) => `- ${hit.record.subject}: ${hit.record.content.slice(0, 240)}`,
      );
      return ok({
        owner: PRODUCT_MEMORY_TOOLS_OWNER,
        recalledCount: recalled.value.selected.length,
        memorySection:
          lines.length === 0
            ? null
            : {
                id: "memory",
                role: "memory",
                source: `memory:${PRODUCT_MEMORY_TOOLS_OWNER}`,
                content: lines.join("\n"),
                required: false,
                available: true,
              },
      });
    },
    admitAfterTurn(input) {
      if (input.outcome.kind !== "completed") {
        return ok({
          owner: PRODUCT_MEMORY_TOOLS_OWNER,
          admittedId: null,
          admitted: false,
        });
      }

      const id = `mem-${String(input.turnId)}`;
      const admitted = ports.admission.admit(
        {
          memoryId: id,
          scope: { kind: "workspace", workspaceId: String(input.workspaceId) },
          kind: "project-fact",
          subject: `turn:${String(input.turnId)}`,
          content: input.task.slice(0, 2_048),
          provenance: [{ origin: "user-request", locator: String(input.turnId) }],
          confidence: 70,
          createdAt: timestampFromEpochMilliseconds(Date.now()),
        },
        {
          sourceKind: "user",
          sourceTrust: "user-confirmed",
          workspaceId: String(input.workspaceId),
        },
        input.signal,
      );
      if (!admitted.ok) {
        if (admitted.error.code === "conflict" && ports.admission.get(id).ok) {
          return ok({ owner: PRODUCT_MEMORY_TOOLS_OWNER, admittedId: id, admitted: false });
        }
        return err({ code: admitted.error.code });
      }
      return ok({ owner: PRODUCT_MEMORY_TOOLS_OWNER, admittedId: id, admitted: true });
    },
  };
}
