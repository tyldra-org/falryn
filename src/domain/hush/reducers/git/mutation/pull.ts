import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationLines,
  gitMutationSummary,
} from "./shared.ts";

export function gitPullProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (!canSummarizeGitMutation(capture, patterns) || args.includes("--dry-run")) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const text = gitMutationLines(capture).join("\n");
  if (/Already up[- ]to[- ]date\.?/iu.test(text)) {
    return gitMutationSummary("ok up-to-date", maxBytes);
  }
  const files = count(text, /(\d+)\s+files?\s+changed/iu);
  if (files === null) {
    return gitMutationSummary("ok", maxBytes);
  }
  const insertions = count(text, /(\d+)\s+insertions?\(\+\)/iu) ?? 0;
  const deletions = count(text, /(\d+)\s+deletions?\(-\)/iu) ?? 0;
  return gitMutationSummary(
    `ok ${files} ${files === 1 ? "file" : "files"} +${insertions} -${deletions}`,
    maxBytes,
  );
}

function count(text: string, pattern: RegExp): number | null {
  const value = text.match(pattern)?.[1];
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
