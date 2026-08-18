/**
 * Application boundary for memory recall (#111).
 *
 * Recalls from the in-memory store without echoing omitted content. Destination
 * sensitivity and workspace isolation stay in the domain gate. Product tools
 * remain later.
 */

import {
  err,
  type MemoryError,
  type MemoryRecallInput,
  type MemoryRecallResult,
  type Result,
  recallMemory,
} from "../domain/index.ts";
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
  records: MemoryRecords = createMemoryRecords(),
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
