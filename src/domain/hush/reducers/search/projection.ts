import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { formatSearchMatches } from "./format.ts";

export function searchProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const formatted = source === null ? null : formatSearchMatches(source);
  const stdout =
    capture.stdout.encoding === "utf-8" && formatted !== null
      ? boundText(formatted, "stdout", maxBytes)
      : boundStream("stdout", capture.stdout, maxBytes, patterns, true);
  return joinStreams(
    stdout,
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}
