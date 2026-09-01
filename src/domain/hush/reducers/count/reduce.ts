import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import type { HushReducer } from "../contracts.ts";
import { shortestText } from "../shared/text.ts";
import { boundStream, boundText, joinStreams } from "../stream.ts";
import { formatWcOutput } from "./format.ts";

export const reduceCount: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  countProjection(capture, maxBytes, patterns, commandTokens);

export function countProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
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
  const formatted = canFormat && source !== null ? formatWcOutput(source, commandTokens) : null;
  return joinStreams(
    formatted === null || source === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
      : boundText(shortestText(source, formatted), "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}
