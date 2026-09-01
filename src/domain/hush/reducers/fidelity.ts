/** Derive result fidelity from the selected strategy and capture state. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import type { HushFidelity, HushResult, HushStrategy, HushStreamProjection } from "../contracts.ts";

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
