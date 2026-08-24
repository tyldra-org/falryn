import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../../../bounds.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { shortestText } from "../../../text-format.ts";
import { formatPsqlResult } from "./format.ts";

export function psqlProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const canFormat =
    patterns.length === 0 &&
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    capture.stdout.encoding === "utf-8" &&
    !capture.stdout.truncated &&
    capture.stdout.omittedBytes === 0 &&
    !capture.stdout.maxLineExceeded;
  const formatted = canFormat && source !== null ? formatPsqlResult(source) : null;

  return joinStreams(
    formatted === null || source === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
      : boundText(shortestText(source, formatted), "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}
