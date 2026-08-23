/** Generic listing-family reduction; `ls` owns a semantic projection beside it. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../bounds.ts";
import type { HushStreamProjection } from "../contracts.ts";
import { formatPathListing } from "./listing/format.ts";

export function listingProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const formatted =
    source === null || patterns.length > 0 ? null : formatPathListing(source, commandTokens);
  return joinStreams(
    formatted === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, true)
      : boundText(formatted, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}
