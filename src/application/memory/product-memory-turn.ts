/**
 * Product memory around the real turn boundary: recall before the prompt (#788) and,
 * after a settled committed turn, a wake for deterministic reflection (#882). A turn
 * never admits memory by itself; candidates wait for the existing review and admission.
 */

import type { PromptSectionInput } from "../../domain/context/index.ts";
import {
  err,
  ok,
  type Result,
  type TurnId,
  timestampFromEpochMilliseconds,
  type WorkspaceId,
} from "../../domain/foundation/index.ts";
import { PRODUCT_MEMORY_TOOLS_OWNER } from "../tools/product-tools-memory.ts";
import type { MemoryRecallPort } from "./memory-recall.ts";
import type { ReflectionWorker } from "./reflection-worker.ts";

export type ProductMemoryTurnPorts = {
  readonly recall: MemoryRecallPort;
  /** Absent when the session has no durable reflection store. */
  readonly reflection?: Pick<ReflectionWorker, "wake">;
};

export type ProductMemoryRecallResult = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  readonly memorySection: PromptSectionInput | null;
  readonly recalledCount: number;
};

/** Whether a settled turn woke reflection; learning itself is reported by the worker. */
export type ProductReflectionRequest = "requested" | "skipped" | "unavailable";

export type ProductMemoryTurn = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  recallBeforeTurn(input: {
    readonly workspaceId: WorkspaceId;
    readonly task: string;
    readonly signal?: AbortSignal;
  }): Result<ProductMemoryRecallResult, { readonly code: string }>;
  /** Only a completed turn whose events are committed through this sequence. */
  reflectAfterTurn(input: {
    readonly turnId: TurnId;
    readonly committedThrough: number | null;
  }): ProductReflectionRequest;
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
    reflectAfterTurn(input) {
      if (ports.reflection === undefined || input.committedThrough === null) return "unavailable";
      return ports.reflection.wake({ throughSequence: input.committedThrough }) === "accepted"
        ? "requested"
        : "unavailable";
    },
  };
}
