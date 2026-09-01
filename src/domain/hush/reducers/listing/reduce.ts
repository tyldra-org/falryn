/** Generic listing-family reduction; `ls` owns its structured projection. */

import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import { boundStream, boundText, joinStreams } from "../stream.ts";
import { formatPathListing } from "./format.ts";

export const reduceListing: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  listingProjection(capture, maxBytes, patterns, commandTokens);

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
