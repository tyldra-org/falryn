/** Safe network projection over complete successful captures. */

import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { passthroughProjection } from "../fallback.ts";
import { shortestText, stripAnsi } from "../shared/text.ts";
import { boundStream, boundText, joinStreams } from "../stream.ts";
import { formatNetworkOutput } from "./format.ts";

export function networkProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const exact = passthroughProjection(capture, maxBytes, patterns);
  if (!completeSuccess(capture) || patterns.length > 0) return exact;
  const source = capture.stdout.inlineText;
  if (source === null) return exact;
  const plain = stripAnsi(source);
  const formatted = formatNetworkOutput(plain, commandTokens);
  if (formatted === null) return exact;
  return joinStreams(
    boundText(shortestText(plain, formatted), "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}

function completeSuccess(capture: ProcessCaptureReport): boolean {
  return (
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    completeText(capture.stdout) &&
    completeText(capture.stderr)
  );
}

function completeText(stream: ProcessStreamCapture): boolean {
  return (
    stream.encoding === "utf-8" &&
    stream.inlineText !== null &&
    !stream.truncated &&
    stream.omittedBytes === 0 &&
    !stream.maxLineExceeded
  );
}
