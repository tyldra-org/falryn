import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationLines,
  gitMutationSummary,
} from "./shared.ts";

const DETAIL_FLAGS = new Set(["--dry-run", "-v", "--verbose", "--porcelain", "--progress"]);
const FETCH_REF =
  /^(?:[+*=!-]\s+)?(?:\[[^\]]+\]|[0-9a-f]{4,64}\.\.\.?[0-9a-f]{4,64})\s+\S+\s+->\s+\S+(?:\s+\([^)]+\))?$/iu;

export function gitFetchProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (!canSummarizeGitMutation(capture, patterns) || args.some((arg) => DETAIL_FLAGS.has(arg))) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const formatted = formatGitFetchSuccess(gitMutationLines(capture));
  return formatted === null
    ? gitMutationFallbackProjection(capture, maxBytes, patterns)
    : gitMutationSummary(formatted, maxBytes);
}

export function formatGitFetchSuccess(lines: readonly string[]): string | null {
  let refs = 0;
  for (const line of lines) {
    if (line.startsWith("From ") || line.startsWith("Fetching ")) {
      continue;
    }
    if (!FETCH_REF.test(line)) {
      return null;
    }
    refs += 1;
  }
  if (refs === 0) {
    return "fetched";
  }
  return `fetched ${refs} ${refs === 1 ? "ref" : "refs"}`;
}
