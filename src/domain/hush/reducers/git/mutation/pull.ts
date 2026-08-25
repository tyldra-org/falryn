import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationLines,
  gitMutationSummary,
} from "./shared.ts";

const UP_TO_DATE = /^Already up[- ]to[- ]date\.?$/iu;

export function gitPullProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (!canSummarizeGitMutation(capture, patterns) || args.includes("--dry-run")) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const lines = gitMutationLines(capture);
  const text = lines.join("\n");
  if (/^warning:/imu.test(text)) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  if (lines.some((line) => UP_TO_DATE.test(line))) {
    return lines.every((line) => UP_TO_DATE.test(line))
      ? gitMutationSummary("ok up-to-date", maxBytes)
      : gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const files = count(text, /(\d+)\s+files?\s+changed/iu);
  if (files === null) {
    return text.length === 0
      ? gitMutationSummary("ok", maxBytes)
      : gitMutationFallbackProjection(capture, maxBytes, patterns);
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
