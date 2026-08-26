import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import { losslessTextProjection } from "../lossless-text.ts";

export const reduceSearch: HushReducer = ({ capture, maxBytes, patterns }) =>
  searchProjection(capture, maxBytes, patterns);

export function searchProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return losslessTextProjection(capture, maxBytes, patterns, true);
}
