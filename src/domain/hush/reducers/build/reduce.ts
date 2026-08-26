/** Safe build projection over complete captures only. */

import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { passthroughProjection } from "../fallback.ts";
import { plainTextProjection } from "../plain-text.ts";
import { shortestText, stripAnsi } from "../shared/text.ts";
import { boundText } from "../stream.ts";
import { formatBuildOutput } from "./format.ts";

export function buildProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  if (patterns.length > 0) {
    return plainTextProjection("build", capture, maxBytes, patterns);
  }
  const exact = passthroughProjection(capture, maxBytes, patterns);
  if (!completeCapture(capture)) return exact;
  const source = [capture.stdout.inlineText, capture.stderr.inlineText]
    .filter((text): text is string => text !== null && text.length > 0)
    .map(stripAnsi)
    .join("\n");
  const formatted = formatBuildOutput(source, commandTokens);
  if (formatted === null || (formatted.length === 0 && capture.exit.exitCode !== 0)) return exact;
  return boundText(shortestText(exact.text, formatted), "both", maxBytes);
}

function completeCapture(capture: ProcessCaptureReport): boolean {
  return (
    capture.stop.kind === "exited" &&
    capture.exit.signal === null &&
    completeText(capture.stdout) &&
    completeText(capture.stderr)
  );
}

function completeText(capture: ProcessStreamCapture): boolean {
  return (
    capture.encoding === "utf-8" &&
    capture.inlineText !== null &&
    !capture.truncated &&
    capture.omittedBytes === 0 &&
    !capture.maxLineExceeded
  );
}
