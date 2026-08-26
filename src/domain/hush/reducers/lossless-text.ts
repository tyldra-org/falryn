/** Complete-capture text projection with only count- and syntax-preserving compaction. */

import type { ProcessCaptureReport, ProcessStreamCapture } from "../../process-capture.ts";
import type { HushStreamProjection } from "../contracts.ts";
import { formatSearchMatches } from "./search/format.ts";
import { compactDuplicateRuns, shortestText, stripAnsi } from "./shared/text.ts";
import { binaryOmission, boundText, joinStreams } from "./stream.ts";

export function losslessTextProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  searchAware: boolean,
): HushStreamProjection {
  if (!canProject(capture, patterns)) {
    return exactProjection(capture, maxBytes);
  }
  return joinStreams(
    projectStream(capture.stdout, "stdout", maxBytes, searchAware),
    projectStream(capture.stderr, "stderr", maxBytes, false),
    maxBytes,
  );
}

function projectStream(
  capture: ProcessStreamCapture,
  stream: "stdout" | "stderr",
  maxBytes: number,
  searchAware: boolean,
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }
  const plain = stripAnsi(capture.inlineText);
  const duplicateCompaction = compactDuplicateRuns(plain);
  const searchCompaction = searchAware ? formatSearchMatches(plain) : null;
  return boundText(
    shortestText(
      capture.inlineText,
      plain,
      duplicateCompaction,
      ...(searchCompaction === null ? [] : [searchCompaction]),
    ),
    stream,
    maxBytes,
  );
}

function canProject(capture: ProcessCaptureReport, patterns: readonly string[]): boolean {
  return (
    patterns.length === 0 &&
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
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

function exactProjection(capture: ProcessCaptureReport, maxBytes: number): HushStreamProjection {
  return joinStreams(
    capture.stdout.encoding === "binary" || capture.stdout.inlineText === null
      ? binaryOmission("stdout", capture.stdout)
      : boundText(capture.stdout.inlineText, "stdout", maxBytes),
    capture.stderr.encoding === "binary" || capture.stderr.inlineText === null
      ? binaryOmission("stderr", capture.stderr)
      : boundText(capture.stderr.inlineText, "stderr", maxBytes),
    maxBytes,
  );
}
