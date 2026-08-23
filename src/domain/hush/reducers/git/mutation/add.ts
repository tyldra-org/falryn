import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationSummary,
} from "./shared.ts";

export function gitAddProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (
    !canSummarizeGitMutation(capture, patterns) ||
    args.some((arg) => arg === "-n" || arg === "--dry-run")
  ) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  return gitMutationSummary("ok", maxBytes);
}
