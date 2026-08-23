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
  const hash = commitHash(capture.stdout.inlineText ?? "");
  return gitMutationSummary(hash === null ? "ok" : `ok ${hash}`, maxBytes);
}

function commitHash(stdout: string): string | null {
  const bracket = stdout.split("\n", 1)[0]?.match(/^\[([^\]]+)\]/u)?.[1];
  const hashes = bracket?.match(/[0-9a-f]{7,64}/giu);
  const hash = hashes?.at(-1);
  return hash === undefined ? null : [...hash].slice(0, 7).join("");
}
