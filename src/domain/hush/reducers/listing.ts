/** Generic listing-family reduction; `ls` owns a semantic projection beside it. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import { boundStream, groupLines, joinStreams } from "../bounds.ts";
import type { HushStreamProjection } from "../contracts.ts";

export function listingProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    groupLines("stdout", capture.stdout, maxBytes, patterns, () => "entry", 32),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}
