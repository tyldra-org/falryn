/** Safe typecheck projection with exact fallback for unknown diagnostic shapes. */

import type { ProcessCaptureReport, ProcessStreamCapture } from "../../../process-capture.ts";
import { boundText, joinStreams } from "../../bounds.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { shortestText, stripAnsi } from "../../text-format.ts";
import { semanticProjection } from "../semantic.ts";
import { formatTypecheckDiagnostics } from "./format.ts";

const TYPECHECK_EXECUTABLES = new Set(["basedpyright", "tsc", "ty"]);

export function diagnosticProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  if (patterns.length > 0 || !isTypecheckCommand(commandTokens) || !completeCapture(capture)) {
    return semanticProjection("diagnostic", capture, maxBytes, patterns);
  }
  const exact = joinStreams(
    boundText(capture.stdout.inlineText ?? "", "stdout", maxBytes),
    boundText(capture.stderr.inlineText ?? "", "stderr", maxBytes),
    maxBytes,
  );
  const source = [capture.stdout.inlineText, capture.stderr.inlineText]
    .filter((text): text is string => text !== null && text.length > 0)
    .map(stripAnsi)
    .join("\n");
  const formatted = formatTypecheckDiagnostics(source, commandTokens);
  if (formatted === null || (formatted.length === 0 && capture.exit.exitCode !== 0)) {
    return exact;
  }
  return boundText(shortestText(exact.text, formatted), "both", maxBytes);
}

function isTypecheckCommand(commandTokens: readonly string[]): boolean {
  return (
    TYPECHECK_EXECUTABLES.has(commandTokens[0] ?? "") ||
    (commandTokens[0] === "bun" && commandTokens[1] === "run" && commandTokens[2] === "typecheck")
  );
}

function completeCapture(capture: ProcessCaptureReport): boolean {
  return (
    capture.stop.kind === "exited" &&
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
