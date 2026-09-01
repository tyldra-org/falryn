/** Safe cloud projection over complete output with exact fallback. */

import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { shortestText, stripAnsi } from "../shared/text.ts";
import { boundStream, boundText, joinStreams } from "../stream.ts";
import { formatCloudOutput } from "./format.ts";

export function cloudProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const exact = exactProjection(capture, maxBytes, patterns);
  if (!completeSuccess(capture) || patterns.length > 0) return exact;
  const source = capture.stdout.inlineText;
  if (source === null) return exact;
  const plain = stripAnsi(source);
  const formatted = formatCloudOutput(plain, commandTokens);
  if (formatted === null) return exact;
  return joinStreams(
    boundText(shortestText(plain, formatted), "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}

function exactProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    boundStream("stdout", capture.stdout, maxBytes, patterns, false),
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
