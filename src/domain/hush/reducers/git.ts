/** Git-specific Hush reducers over captured output. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import {
  boundStream,
  boundText,
  genericProjection,
  joinStreams,
  matchesPattern,
} from "../bounds.ts";
import type { HushStreamProjection } from "../contracts.ts";

export function gitDiffProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const text = capture.stdout.inlineText;
  if (text === null || capture.stdout.encoding === "binary") {
    return genericProjection(capture, maxBytes, patterns);
  }
  const stats: string[] = [];
  let file: string | null = null;
  let plus = 0;
  let minus = 0;
  let files = 0;
  const flush = (): void => {
    if (file !== null) {
      stats.push(`${file}: +${plus} -${minus}`);
      file = null;
      plus = 0;
      minus = 0;
    }
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      files += 1;
      if (files > 24) {
        continue;
      }
      file = pathFromDiffGit(line.slice("diff --git ".length));
    } else if (line.startsWith("Binary files ")) {
      flush();
      stats.push(summarizeBinaryDiffLine(line));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      plus += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      minus += 1;
    }
  }
  flush();
  if (files > 24) {
    stats.push(`… and ${files - 24} more files`);
  }
  const stdout =
    stats.length === 0
      ? boundStream("stdout", capture.stdout, maxBytes, patterns, true)
      : boundText(stats.join("\n"), "stdout", maxBytes);
  const omittedHunks = Math.max(0, text.split("\n").length - stats.length);
  return joinStreams(
    {
      text: stdout.text,
      omissions: [
        ...(omittedHunks > 0
          ? [
              {
                kind: "capped-lines" as const,
                stream: "stdout" as const,
                count: omittedHunks,
                detail: "hunks",
              },
            ]
          : []),
        ...stdout.omissions,
      ],
    },
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

export function gitStatusProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const text = capture.stdout.inlineText;
  if (text === null || capture.stdout.encoding === "binary") {
    return genericProjection(capture, maxBytes, patterns);
  }
  const groups = new Map<string, number>();
  const kept: string[] = [];
  let omitted = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ") || matchesPattern(line, patterns)) {
      kept.push(line);
      continue;
    }
    const path = porcelainPath(line);
    if (path === null) {
      kept.push(line);
      continue;
    }
    const key = statusGroupKey(path);
    const seen = groups.get(key) ?? 0;
    if (seen < 8) {
      kept.push(line);
      groups.set(key, seen + 1);
    } else {
      omitted += 1;
    }
  }
  const bounded = boundText(kept.join("\n"), "stdout", maxBytes);
  return joinStreams(
    {
      text: bounded.text,
      omissions: [
        ...(omitted > 0
          ? [
              {
                kind: "capped-lines" as const,
                stream: "stdout" as const,
                count: omitted,
                detail: null,
              },
            ]
          : []),
        ...bounded.omissions,
      ],
    },
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

export function gitGroupKey(line: string): string {
  if (line.startsWith("diff --git ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
    return line;
  }
  const path = /(?:^|\s)([^\s]+\/[^\s]+|[^\s]+\.[A-Za-z0-9]+)\s*$/.exec(line);
  return path?.[1] ?? "git";
}

function pathFromDiffGit(rest: string): string {
  const parts = rest.split(/\s+/);
  const left = parts[0] ?? rest;
  const right = parts[1] ?? left;
  const from = stripDiffPath(left);
  const to = stripDiffPath(right);
  return from === to ? from : `${from} → ${to}`;
}

function summarizeBinaryDiffLine(line: string): string {
  const rest = line.startsWith("Binary files ") ? line.slice("Binary files ".length) : null;
  if (rest === null) {
    return line;
  }
  const splitAt = rest.indexOf(" and ");
  if (splitAt < 0) {
    return line;
  }
  const left = rest.slice(0, splitAt).trim();
  const right = rest
    .slice(splitAt + " and ".length)
    .replace(/ differ$/, "")
    .trim();
  return `Binary: ${stripDiffPath(left)} → ${stripDiffPath(right)}`;
}

function stripDiffPath(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

const PORCELAIN_CODES = new Set([" ", "M", "A", "D", "R", "C", "U", "?", "!"]);

function porcelainPath(line: string): string | null {
  const x = line[0];
  const y = line[1];
  if (x === undefined || y === undefined || line[2] !== " " || line.length < 4) {
    return null;
  }
  if (!PORCELAIN_CODES.has(x) || !PORCELAIN_CODES.has(y)) {
    return null;
  }
  const renamed = line.slice(3).trim().split(" -> ");
  const path = renamed[renamed.length - 1];
  return path === undefined || path.length === 0 ? null : path;
}

const TWO_LEVEL_STATUS_ROOTS = new Set([
  "crates",
  "src",
  "docs",
  "tests",
  "packages",
  "apps",
  "libs",
]);

function statusGroupKey(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) {
    return ".";
  }
  if (TWO_LEVEL_STATUS_ROOTS.has(first)) {
    return `${first}/${second}`;
  }
  return first;
}
