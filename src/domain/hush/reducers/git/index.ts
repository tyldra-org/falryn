import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { semanticProjection } from "../semantic.ts";

export { gitDiffProjection } from "./diff.ts";
export { gitMutationProjection } from "./mutation.ts";
export { gitStatusProjection } from "./status.ts";

export function gitLogProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return semanticProjection("operation", capture, maxBytes, patterns);
}
