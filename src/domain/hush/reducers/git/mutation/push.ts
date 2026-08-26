import type { ProcessCaptureReport } from "../../../../process-capture.ts";
import type { HushStreamProjection } from "../../../contracts.ts";
import {
  canSummarizeGitMutation,
  gitMutationFallbackProjection,
  gitMutationLines,
  gitMutationSummary,
} from "./shared.ts";

export function gitPushProjection(
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
  const lines = gitMutationLines(capture);
  if (lines.some((line) => line.includes("Everything up-to-date"))) {
    const extras = lines.filter((line) => !line.includes("Everything up-to-date"));
    return gitMutationSummary(["ok up-to-date", ...extras].join("\n"), maxBytes);
  }
  const summary = formatPush(lines);
  return summary === null
    ? gitMutationFallbackProjection(capture, maxBytes, patterns)
    : gitMutationSummary(summary, maxBytes);
}

function formatPush(lines: readonly string[]): string | null {
  const remote = lines
    .find((line) => line.startsWith("To "))
    ?.slice(3)
    .trim();
  const refs = lines.filter((line) => line.includes(" -> "));
  const tracking = lines.filter((line) => /^branch '.+' set up to track '.+'\.?$/u.test(line));
  if (remote === undefined && refs.length === 0) {
    return null;
  }

  const consumed = new Set([
    ...(remote === undefined ? [] : [`To ${remote}`]),
    ...refs,
    ...tracking,
  ]);
  const output = [remote === undefined ? "push" : `push ${remote}`];
  output.push(...refs.map(compactRef));
  output.push(...tracking.map(compactTracking));
  output.push(...lines.filter((line) => !consumed.has(line)));
  return output.join("\n");
}

function compactRef(line: string): string {
  const normalized = line.replace(/\s+/gu, " ").trim();
  const update = normalized.match(
    /^(\+ )?([0-9a-f]+(?:\.{2,3})[0-9a-f]+) (\S+) -> (\S+)(?: \(([^)]+)\))?$/iu,
  );
  if (update !== null) {
    const [, marker, range, source, destination, note] = update;
    const forced = marker !== undefined || note === "forced update" ? " forced" : "";
    return `${refName(source, destination)} ${range}${forced}`;
  }
  const ref = normalized.match(
    /^(?:([*+\-=]) )?(?:\[([^\]]+)\] )?(\S+) -> (\S+)(?: \(([^)]+)\))?$/u,
  );
  if (ref === null) {
    return normalized;
  }
  const [, marker, kind, source, destination, note] = ref;
  if (kind === "new branch") {
    return `new ${refName(source, destination)}`;
  }
  if (kind === "new tag") {
    return `new tag ${destination}`;
  }
  if (kind === "deleted") {
    return `deleted ${destination}`;
  }
  const name = refName(source, destination);
  const forced = marker === "+" || note === "forced update" ? " forced" : "";
  return `${name}${name.length > 0 ? " " : ""}${kind ?? "updated"}${forced}`;
}

function refName(source: string | undefined, destination: string | undefined): string {
  if (source === undefined || destination === undefined) {
    return source ?? destination ?? "";
  }
  return source === destination ? destination : `${source}->${destination}`;
}

function compactTracking(line: string): string {
  const match = line.match(/^branch '([^']+)' set up to track '([^']+)'\.?$/u);
  return match === null ? line : `tracks ${match[1]}->${match[2]}`;
}
