import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationSummary,
} from "./shared.ts";

const ACTION_FLAGS = new Set([
  "-d",
  "-D",
  "--delete",
  "-m",
  "-M",
  "--move",
  "-c",
  "-C",
  "--copy",
  "--set-upstream-to",
  "-u",
  "--set-upstream",
  "--unset-upstream",
  "--edit-description",
]);

const LIST_FLAGS = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-l",
  "--list",
  "--merged",
  "--no-merged",
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
]);

const BRANCH_VALUE_FLAGS = new Set([
  "--abbrev",
  "--color",
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format",
  "--set-upstream-to",
  "-u",
]);

export function gitBranchProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  args: readonly string[],
): HushStreamProjection {
  if (!canSummarizeGitMutation(capture, patterns)) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const stdout = capture.stdout.inlineText ?? "";
  const stderr = capture.stderr.inlineText ?? "";
  if (args.includes("--show-current")) {
    const branch = singleLine(stdout);
    return stderr.length === 0 && branch !== null
      ? gitMutationSummary(branch, maxBytes)
      : gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  if (hasCustomPresentation(args)) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  if (isBranchMutation(args)) {
    return stdout.length === 0 && stderr.length === 0
      ? gitMutationSummary("ok", maxBytes)
      : gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  if (stderr.length > 0) {
    return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
  const formatted = formatGitBranchList(stdout);
  return formatted === null
    ? gitMutationFallbackProjection(capture, maxBytes, patterns)
    : gitMutationSummary(formatted, maxBytes);
}

export function formatGitBranchList(source: string): string | null {
  if (source.length === 0) {
    return "";
  }
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  const formatted: string[] = [];
  for (const line of lines) {
    const match = /^([*+ ]) (.+)$/u.exec(line);
    if (match === null) {
      return null;
    }
    const marker = match[1];
    const value = match[2];
    if (marker === undefined || value === undefined || value.length === 0) {
      return null;
    }
    formatted.push(marker === " " ? value : `${marker} ${value}`);
  }
  return formatted.join("\n");
}

function hasCustomPresentation(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--format" ||
      arg.startsWith("--format=") ||
      arg === "--column" ||
      arg.startsWith("--column=") ||
      arg === "--color" ||
      arg.startsWith("--color="),
  );
}

function isBranchMutation(args: readonly string[]): boolean {
  if (args.some((arg) => matchesFlag(arg, ACTION_FLAGS))) {
    return true;
  }
  const listMode = args.some((arg) => matchesFlag(arg, LIST_FLAGS));
  return !listMode && positionalBranchArguments(args).length > 0;
}

function positionalBranchArguments(args: readonly string[]): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (BRANCH_VALUE_FLAGS.has(arg)) {
      index += 1;
    } else if (!arg.startsWith("-")) {
      values.push(arg);
    }
  }
  return values;
}

function matchesFlag(arg: string, flags: ReadonlySet<string>): boolean {
  const normalized = arg.split("=", 1)[0] ?? arg;
  return flags.has(normalized);
}

function singleLine(source: string): string | null {
  const value = source.endsWith("\n") ? source.slice(0, -1) : source;
  return value.includes("\n") || value.includes("\r") ? null : value;
}
