import type { ProcessCaptureReport } from "../../../process-capture.ts";
import { KUBERNETES_EXECUTABLES } from "../../command/kubernetes.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { formatContainerLogOutput } from "../container/log.ts";
import { CONTAINER_EXECUTABLES, containerExecutable } from "../container/shared.ts";
import type { HushReducer } from "../contracts.ts";
import { formatKubernetesLogOutput } from "../kubernetes/log.ts";
import { plainTextStreamProjection } from "../plain-text.ts";
import { shortestText, stripAnsi } from "../shared/text.ts";
import { boundStream, boundText, joinStreams } from "../stream.ts";
import { formatShortJournal } from "./format.ts";

export const reduceLog: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  logProjection(capture, maxBytes, patterns, commandTokens);

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
  const kubernetes = KUBERNETES_EXECUTABLES.has(containerExecutable(commandTokens));
  const formatted =
    plain === null
      ? null
      : container
        ? formatContainerLogOutput(plain)
        : kubernetes
          ? formatKubernetesLogOutput(plain)
          : formatShortJournal(plain);
  const stdout =
    formatted === null || plain === null
      ? kubernetes
        ? boundStream("stdout", capture.stdout, maxBytes, patterns, false)
        : plainTextStreamProjection("log", "stdout", capture.stdout, maxBytes, patterns)
      : boundText(shortestText(plain, formatted), "stdout", maxBytes);
  return joinStreams(
    stdout,
    plainTextStreamProjection("log", "stderr", capture.stderr, maxBytes, patterns),
    maxBytes,
  );
}
