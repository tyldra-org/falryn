import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationLines,
  gitMutationSummary,
} from "./shared.ts";

const INTERACTIVE_FLAGS = new Set(["-p", "--patch", "--ours", "--theirs", "--merge"]);

export function gitCheckoutProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (
    !canSummarizeGitMutation(capture, patterns) ||
    args.some((arg) => INTERACTIVE_FLAGS.has(arg) || arg.startsWith("--conflict="))
  ) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const lines = gitMutationLines(capture);
  if (lines.length === 0) {
    return gitMutationSummary("ok", maxBytes);
  }
  if (lines.length !== 1) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const formatted = formatGitCheckoutSuccess(lines[0] ?? "");
  return formatted === null
    ? gitMutationFallbackProjection(capture, maxBytes, patterns)
    : gitMutationSummary(formatted, maxBytes);
}

export function formatGitCheckoutSuccess(line: string): string | null {
  const switchedNew = quotedValue(line, "Switched to a new branch ");
  if (switchedNew !== null) {
    return `ok ${switchedNew} new`;
  }
  const switched = quotedValue(line, "Switched to branch ");
  if (switched !== null) {
    return `ok ${switched}`;
  }
  const current = quotedValue(line, "Already on ");
  if (current !== null) {
    return `ok ${current}`;
  }
  const detached = /^HEAD is now at ([0-9a-f]{7,64})(?:\s|$)/iu.exec(line)?.[1];
  if (detached !== undefined) {
    return `ok HEAD ${[...detached].slice(0, 8).join("")}`;
  }
  const restored = /^Updated (\d+) paths? from the index$/u.exec(line)?.[1];
  return restored === undefined ? null : `ok restored ${restored}`;
}

function quotedValue(line: string, prefix: string): string | null {
  const value = line.startsWith(prefix) ? line.slice(prefix.length) : "";
  return value.startsWith("'") && value.endsWith("'") && value.length > 2
    ? value.slice(1, -1)
    : null;
}
