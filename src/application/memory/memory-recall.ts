/**
 * Application boundary for memory recall (#111).
 *
 * Recalls from the in-memory store without echoing omitted content. Destination
 * sensitivity and workspace isolation stay in the domain gate. Product tools
 * remain later.
 */

import { err, type Result } from "../../domain/foundation/index.ts";
import {
  type MemoryError,
  type MemoryRecallInput,
  type MemoryRecallResult,
  recallMemory,
} from "../../domain/memory/index.ts";
import { createMemoryRecords, type MemoryRecords } from "./memory-record.ts";

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

export type MemoryRecallPort = {
  recall(
    input: Omit<MemoryRecallInput, "records">,
    signal?: AbortSignal,
  ): Result<MemoryRecallResult, MemoryError>;
};

export function createMemoryRecall(
  records: Pick<MemoryRecords, "list"> = createMemoryRecords(),
): MemoryRecallPort {
  return {
    recall(input, signal) {
      if (signal?.aborted) {
        return err(memoryError("cancelled", "signal"));
      }
      return recallMemory({ ...input, records: records.list() });
    },
  };
}
