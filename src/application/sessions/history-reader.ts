/** Resource admission for the shared, effect-free history reader. */
import { randomUUID } from "node:crypto";
import { deadlineAt, instant, MAX_STREAM_READ_LIMIT } from "../../domain/foundation/index.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/index.ts";
import { HISTORY_LIMITS } from "../../domain/sessions/history.ts";
import { createHistoryReader as createReader } from "../../domain/sessions/history-reader.ts";
import {
  type ProductTaskResources,
  processProductResources,
} from "../orchestration/product-resources.ts";
import { historyDigest } from "./session-history.ts";

export type {
  HistoryAvailability,
  HistoryReadItem,
} from "../../domain/sessions/history-read-result.ts";
export function createHistoryReader(
  options: Omit<Parameters<typeof createReader>[0], "digest"> & {
    readonly resources?: ProductTaskResources;
  },
) {
  const reader = createReader({ ...options, digest: historyDigest });
  return {
    async page(input: Parameters<typeof reader.page>[0], signal = new AbortController().signal) {
      const resources = options.resources ?? processProductResources.openTask("history-read");
      const operation = `history-read:${randomUUID()}`;
      try {
        const result = await resources.execute({
          operation,
          attempt: operation,
          generation: resources.generation,
          signal,
          inputBytes: 512,
          // A checkpoint read also validates its bounded original source range.
          amounts: {
            operations: 1,
            bufferedBytes: 4 * HISTORY_LIMITS.contentBytes,
            bufferedItems: MAX_STREAM_READ_LIMIT + HISTORY_LIMITS.page + 1,
          },
          unit: {
            id: workUnitId(operation),
            effect: "observation",
            priority: "interactive",
            conflictKeys: [],
            dependencies: [],
            deadline: deadlineAt(instant(Math.min(Date.now() + 30000, resources.expiresAt))),
            expectedOutputBytes: 5 * 1024 * 1024,
            retry: NO_RETRY,
            scopeId: null,
          },
          async run(admittedSignal) {
            return {
              value: await reader.page(input, admittedSignal),
              terminated: true,
              observedEffect: "none" as const,
            };
          },
        });
        return result.kind === "completed"
          ? result.value
          : { ok: false as const, code: result.receipt.state };
      } finally {
        if (!options.resources) resources.close();
      }
    },
  };
}
