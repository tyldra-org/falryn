import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { compactJsonWhitespace, shortestText } from "../../shared/text.ts";
import { boundStream, boundText, joinStreams } from "../../stream.ts";
import { formatSqliteResult } from "./format.ts";

export function sqliteProjection(
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
  const formatted = canFormat && source !== null ? formatSqliteResult(source) : null;
  const json = canFormat && source !== null ? compactJsonWhitespace(source) : null;
  const candidates = [source, formatted, json].filter((text): text is string => text !== null);

  return joinStreams(
    !canFormat || source === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
      : boundText(shortestText(...candidates), "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}
