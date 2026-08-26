import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundStream, boundText, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { shortestText } from "../../text-format.ts";
import { CONTAINER_EXECUTABLES } from "../container/shared.ts";
import { formatContainerTableOutput } from "../container/table.ts";
import { formatAlignedTable } from "./format.ts";
import { formatSystemTableResult, isSystemTableExecutable } from "./system/format.ts";

export function tableProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[] = [],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const executable = commandTokens[0]?.split(/[\\/]/u).at(-1) ?? "";
  if (CONTAINER_EXECUTABLES.has(executable)) {
    return containerTableProjection(capture, source, maxBytes, patterns, commandTokens);
  }
  if (isSystemTableExecutable(executable)) {
    return systemTableProjection(executable, capture, source, maxBytes, patterns);
  }
  const formatted = source === null || patterns.length > 0 ? null : formatAlignedTable(source);
  return joinStreams(
    formatted === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, true)
      : boundText(formatted, "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, true),
    maxBytes,
  );
}

function containerTableProjection(
  capture: ProcessCaptureReport,
  source: string | null,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const canFormat =
    patterns.length === 0 &&
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    capture.stdout.encoding === "utf-8" &&
    !capture.stdout.truncated &&
    capture.stdout.omittedBytes === 0 &&
    !capture.stdout.maxLineExceeded;
  const formatted =
    canFormat && source !== null ? formatContainerTableOutput(source, commandTokens) : null;
  return joinStreams(
    !canFormat || formatted === null || source === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
      : boundText(shortestText(source, formatted), "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}

function systemTableProjection(
  executable: Parameters<typeof formatSystemTableResult>[0],
  capture: ProcessCaptureReport,
  source: string | null,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const canFormat =
    patterns.length === 0 &&
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null &&
    capture.stdout.encoding === "utf-8" &&
    !capture.stdout.truncated &&
    capture.stdout.omittedBytes === 0 &&
    !capture.stdout.maxLineExceeded;
  const formatted =
    canFormat && source !== null ? formatSystemTableResult(executable, source) : null;
  return joinStreams(
    !canFormat || formatted === null || source === null
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
      : boundText(shortestText(source, formatted), "stdout", maxBytes),
    boundStream("stderr", capture.stderr, maxBytes, patterns, false),
    maxBytes,
  );
}
