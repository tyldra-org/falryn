import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationSummary,
} from "./shared.ts";

export function gitCommitProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (!canSummarizeGitMutation(capture, patterns) || args.includes("--dry-run")) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const stdout = capture.stdout.inlineText ?? "";
  if ((capture.stderr.inlineText ?? "").trim().length > 0) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  if (stdout.length === 0) {
    return gitMutationSummary("ok", maxBytes);
  }
  const lines = stdout.trimEnd().split("\n");
  const hash = commitHash(lines[0] ?? "");
  if (hash === null || !lines.slice(1).every(isNativeCommitSummaryLine)) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  return gitMutationSummary(`ok ${hash}`, maxBytes);
}

function commitHash(stdout: string): string | null {
  const bracket = stdout.split("\n", 1)[0]?.match(/^\[([^\]]+)\]/u)?.[1];
  const hashes = bracket?.match(/[0-9a-f]{7,64}/giu);
  const hash = hashes?.at(-1);
  return hash === undefined ? null : [...hash].slice(0, 7).join("");
}

function isNativeCommitSummaryLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    /^\d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?$/u.test(trimmed) ||
    /^(?:create|delete) mode \d{6} .+$/u.test(trimmed) ||
    /^(?:rename|copy|rewrite) .+ \(\d+%\)$/u.test(trimmed)
  );
}
