import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import { formatGitUnifiedDiff } from "../diff/format.ts";
import { formatGitDiffStat } from "../diff/stat.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationLines,
  gitMutationSummary,
} from "./shared.ts";

const STASH_SUBCOMMANDS = new Set([
  "apply",
  "branch",
  "clear",
  "create",
  "drop",
  "export",
  "import",
  "list",
  "pop",
  "push",
  "save",
  "show",
  "store",
]);

export function gitStashProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (!canSummarizeGitMutation(capture, patterns)) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const subcommand = stashSubcommand(args);
  if (subcommand === "list") {
    return projectStashList(capture, maxBytes, patterns, args);
  }
  if (subcommand === "show") {
    return projectStashShow(capture, maxBytes, patterns, args);
  }
  if (subcommand === null || subcommand === "push" || subcommand === "save") {
    const lines = gitMutationLines(capture);
    if (lines.length !== 1) {
      return gitMutationFallbackProjection(capture, maxBytes, patterns);
    }
    const formatted = formatGitStashCreation(lines[0] ?? "");
    return formatted === null
      ? gitMutationFallbackProjection(capture, maxBytes, patterns)
      : gitMutationSummary(formatted, maxBytes);
  }
  const stdout = capture.stdout.inlineText ?? "";
  const stderr = capture.stderr.inlineText ?? "";
  return stdout.length === 0 && stderr.length === 0
    ? gitMutationSummary(`ok ${subcommand}`, maxBytes)
    : gitMutationFallbackProjection(capture, maxBytes, patterns);
}

export function formatGitStashCreation(line: string): string | null {
  if (line === "No local changes to save") {
    return "nothing to stash";
  }
  return line.startsWith("Saved working directory and index state ") ? "stashed" : null;
}

export function formatGitStashList(source: string): string | null {
  if (source.length === 0) {
    return "";
  }
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  const formatted: string[] = [];
  for (const line of lines) {
    const match = /^stash@\{(\d+)\}: (?:WIP on|On) ([^:]+): (.+)$/u.exec(line);
    const index = match?.[1];
    const branch = match?.[2];
    const message = match?.[3];
    if (index === undefined || branch === undefined || message === undefined) {
      return null;
    }
    formatted.push(`${index} ${branch} | ${message}`);
  }
  return formatted.join("\n");
}

function projectStashList(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (
    (capture.stderr.inlineText ?? "").length > 0 ||
    args.some(
      (arg) =>
        arg === "--format" ||
        arg.startsWith("--format=") ||
        arg === "--pretty" ||
        arg.startsWith("--pretty=") ||
        arg === "--date" ||
        arg.startsWith("--date="),
    )
  ) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const formatted = formatGitStashList(capture.stdout.inlineText ?? "");
  return formatted === null
    ? gitMutationFallbackProjection(capture, maxBytes, patterns)
    : gitMutationSummary(formatted, maxBytes);
}

function projectStashShow(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if ((capture.stderr.inlineText ?? "").length > 0) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const source = capture.stdout.inlineText ?? "";
  const formatted = args.some((arg) => arg === "-p" || arg === "--patch")
    ? formatGitUnifiedDiff(source)
    : formatGitDiffStat(source);
  return formatted === null
    ? gitMutationFallbackProjection(capture, maxBytes, patterns)
    : gitMutationSummary(formatted, maxBytes);
}

function stashSubcommand(args: readonly string[]): string | null {
  const candidate = args.find((arg) => !arg.startsWith("-"));
  return candidate !== undefined && STASH_SUBCOMMANDS.has(candidate) ? candidate : null;
}
