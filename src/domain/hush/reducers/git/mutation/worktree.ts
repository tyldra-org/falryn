import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationLines,
  gitMutationSummary,
} from "./shared.ts";

const ACTIONS = new Set(["add", "lock", "move", "prune", "remove", "repair", "unlock"]);
const PREPARATION =
  /^Preparing worktree \((?:new branch|resetting branch|checking out|detached HEAD) .+\)$/u;

export function gitWorktreeProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
  cwd: string | null,
): HushStreamProjection {
  if (!canSummarizeGitMutation(capture, patterns)) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (subcommand === "list") {
    if (
      args.some((arg) => arg === "--porcelain" || arg === "-z") ||
      (capture.stderr.inlineText ?? "").length > 0
    ) {
      return gitMutationFallbackProjection(capture, maxBytes, patterns);
    }
    const formatted = formatGitWorktreeList(capture.stdout.inlineText ?? "", cwd);
    return formatted === null
      ? gitMutationFallbackProjection(capture, maxBytes, patterns)
      : gitMutationSummary(formatted, maxBytes);
  }
  if (
    subcommand === undefined ||
    !ACTIONS.has(subcommand) ||
    args.includes("-n") ||
    args.includes("--dry-run")
  ) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const lines = gitMutationLines(capture);
  return lines.every((line) => PREPARATION.test(line))
    ? gitMutationSummary("ok", maxBytes)
    : gitMutationFallbackProjection(capture, maxBytes, patterns);
}

export function formatGitWorktreeList(source: string, cwd: string | null): string | null {
  if (source.length === 0) {
    return "";
  }
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  const formatted: string[] = [];
  for (const line of lines) {
    const match = /^(.*\S)\s+([0-9a-f]{7,64})\s+(.+)$/iu.exec(line);
    const path = match?.[1];
    const hash = match?.[2];
    const state = match?.[3];
    if (path === undefined || hash === undefined || state === undefined) {
      return null;
    }
    formatted.push(`${cwd !== null && path === cwd ? "." : path} ${hash} ${state}`);
  }
  return formatted.join("\n");
}
