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
    args.some((arg) =>
      [
        "-n",
        "--dry-run",
        "-p",
        "--patch",
        "-i",
        "--interactive",
        "-e",
        "--edit",
        "-v",
        "--verbose",
      ].includes(arg),
    ) ||
    (capture.stdout.inlineText ?? "").length > 0 ||
    (capture.stderr.inlineText ?? "").length > 0
  ) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  return gitMutationSummary("ok", maxBytes);
}
