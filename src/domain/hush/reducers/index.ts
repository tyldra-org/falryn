/** Reducer registry for explicit Hush command projection policies. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import type { HushFidelity, HushResult, HushStrategy, HushStreamProjection } from "../contracts.ts";
import type { HushReducerContext } from "./commands/contracts.ts";
import { commandReducerFor } from "./commands/index.ts";
import { searchReducer } from "./commands/shared/file.ts";
import { compoundProjection } from "./compound/projection.ts";

export function fidelityFor(
  requested: HushStrategy,
  fallback: HushResult["fallbackReason"],
  projection: HushStreamProjection,
  capture: ProcessCaptureReport,
): HushFidelity {
  if (fallback === "reducer-failure") {
    return "raw-fallback";
  }
  if (
    requested === "passthrough" &&
    projection.omissions.length === 0 &&
    !capture.stdout.truncated &&
    !capture.stderr.truncated
  ) {
    return "exact";
  }
  return "deterministic-reduction";
}

export function specializedProjection(
  reducerId: string,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
  commandSegments: readonly (readonly string[])[],
  cwd: string | null,
): HushStreamProjection {
  const context: HushReducerContext = {
    capture,
    maxBytes,
    patterns,
    commandTokens,
    commandSegments,
    cwd,
  };
  if (reducerId === "shell.compound") {
    return compoundProjection(capture, maxBytes, patterns, commandSegments);
  }
  if (reducerId === "files.search") {
    return searchReducer(context);
  }
  const reducer = commandReducerFor(reducerId);
  if (reducer === null) {
    throw new Error(`missing Hush command reducer: ${reducerId}`);
  }
  return reducer(context);
}
