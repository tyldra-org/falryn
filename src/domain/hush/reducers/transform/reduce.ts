import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import { losslessTextProjection } from "../lossless-text.ts";

export const reduceTransform: HushReducer = ({ capture, maxBytes, patterns }) =>
  transformProjection(capture, maxBytes, patterns);

export function transformProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return losslessTextProjection(capture, maxBytes, patterns, false);
}
