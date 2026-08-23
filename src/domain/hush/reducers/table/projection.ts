import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { formatAlignedTable } from "./format.ts";

export function tableProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const formatted = source === null || patterns.length > 0 ? null : formatAlignedTable(source);
  return joinStreams(
    formatted === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, true)
      : boundText(formatted, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}
