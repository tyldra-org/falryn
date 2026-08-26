import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { boundText, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { shortestText, stripAnsi } from "../../text-format.ts";
import { formatContainerLogOutput } from "../container/log.ts";
import { CONTAINER_EXECUTABLES, containerExecutable } from "../container/shared.ts";
import { semanticStreamProjection } from "../semantic.ts";
import { formatShortJournal } from "./format.ts";

export function logProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[] = [],
): HushStreamProjection {
  const source = capture.stdout.inlineText;
  const canFormat =
    patterns.length === 0 &&
    capture.stdout.encoding === "utf-8" &&
    source !== null &&
    !capture.stdout.truncated &&
    capture.stdout.omittedBytes === 0 &&
    !capture.stdout.maxLineExceeded &&
    capture.stop.kind === "exited" &&
    capture.exit.exitCode === 0 &&
    capture.exit.signal === null;
  const plain = canFormat ? stripAnsi(source) : null;
  const container = CONTAINER_EXECUTABLES.has(containerExecutable(commandTokens));
  const formatted =
    plain === null ? null : container ? formatContainerLogOutput(plain) : formatShortJournal(plain);
  const stdout =
    formatted === null || plain === null
      ? semanticStreamProjection("log", "stdout", capture.stdout, maxBytes, patterns)
      : boundText(shortestText(plain, formatted), "stdout", maxBytes);
  return joinStreams(
    stdout,
    semanticStreamProjection("log", "stderr", capture.stderr, maxBytes, patterns),
    maxBytes,
  );
}
