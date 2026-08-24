import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundStream, boundText, genericProjection, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { shortestText } from "../../text-format.ts";
import { formatExternalUnifiedDiff } from "../diff/format.ts";
import { formatGitUnifiedDiff } from "./diff/format.ts";
import { formatGitDiffStat } from "./diff/stat.ts";

export function gitDiffProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[] = [],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  if (source === null || capture.stdout.encoding === "binary") {
    return genericProjection(capture, maxBytes, patterns);
  }

  const canFormat =
    patterns.length === 0 &&
    capture.stop.kind === "exited" &&
    isSuccessfulDiffExit(commandTokens, capture.exit.exitCode) &&
    capture.exit.signal === null &&
    capture.stdout.encoding === "utf-8" &&
    !capture.stdout.truncated &&
    capture.stdout.omittedBytes === 0 &&
    !capture.stdout.maxLineExceeded;
  const formatted = canFormat
    ? (formatGitUnifiedDiff(source) ??
      formatExternalUnifiedDiff(source) ??
      formatGitDiffStat(source))
    : null;
  const stdout =
    formatted === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
      : boundText(shortestText(source, formatted), "stdout", maxBytes);
  return joinStreams(
    stdout,
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}

function isSuccessfulDiffExit(tokens: readonly string[], exitCode: number | null): boolean {
  if (exitCode === 0) {
    return true;
  }
  if (exitCode !== 1) {
    return false;
  }
  const executable = tokens[0]?.split(/[\\/]/u).at(-1) ?? "";
  return (
    executable === "diff" ||
    tokens.includes("--exit-code") ||
    tokens.includes("--quiet") ||
    tokens.includes("--no-index")
  );
}
