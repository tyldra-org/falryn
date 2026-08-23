/** Reducer registry for specialized Hush command families. */

import type { ProcessCaptureReport } from "../../process-capture.ts";
import { assertNever } from "../../result.ts";
import {
  boundStream,
  boundText,
  genericProjection,
  groupLines,
  joinStreams,
  matchesPattern,
} from "../bounds.ts";
import type {
  HushFamily,
  HushFidelity,
  HushResult,
  HushStrategy,
  HushStreamProjection,
} from "../contracts.ts";
import { gitDiffProjection, gitGroupKey, gitStatusProjection } from "./git.ts";
import { listingProjection, lsProjection } from "./listing.ts";

export function fidelityFor(
  requested: HushStrategy,
  fallback: HushResult["fallbackReason"],
  projection: HushStreamProjection,
  capture: ProcessCaptureReport,
): HushFidelity {
  if (fallback === "reducer-failure") {
    return "raw-fallback";
  }
  if (
    requested === "passthrough" &&
    projection.omissions.length === 0 &&
    !capture.stdout.truncated &&
    !capture.stderr.truncated
  ) {
    return "exact";
  }
  return "deterministic-reduction";
}

export function specializedProjection(
  family: HushFamily,
  reducerId: string,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  switch (family) {
    case "search":
      return searchProjection(capture, maxBytes, patterns);
    case "git":
      return reducerId === "git.diff"
        ? gitDiffProjection(capture, maxBytes, patterns)
        : gitStatusProjection(capture, maxBytes, patterns);
    case "github":
      return groupedProjection(capture, maxBytes, patterns, gitGroupKey, 12);
    case "listing":
      return reducerId === "files.ls"
        ? lsProjection(capture, maxBytes, patterns)
        : listingProjection(capture, maxBytes, patterns);
    case "test":
    case "lint":
    case "typecheck":
    case "build":
      return summaryProjection(capture, maxBytes, patterns);
    case "package":
    case "container":
    case "kubernetes":
    case "cloud":
    case "data":
    case "log":
    case "http":
    case "generic":
      return genericProjection(capture, maxBytes, patterns);
    default:
      return assertNever(family, "unhandled hush family");
  }
}

function searchProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    groupLines("stdout", capture.stdout, maxBytes, patterns, searchGroupKey, 8),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function summaryProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const stdout = capture.stdout;
  if (stdout.encoding === "binary" || stdout.inlineText === null) {
    return genericProjection(capture, maxBytes, patterns);
  }
  const kept: string[] = [];
  let omitted = 0;
  for (const line of stdout.inlineText.split("\n")) {
    if (isSummaryLine(line) || matchesPattern(line, patterns) || kept.length < 16) {
      kept.push(line);
    } else {
      omitted += 1;
    }
  }
  const stdoutBound = boundText(kept.join("\n"), "stdout", maxBytes);
  return joinStreams(
    {
      text: stdoutBound.text,
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
        ...stdoutBound.omissions,
      ],
    },
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function groupedProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  keyFor: (line: string) => string,
  perGroup: number,
): HushStreamProjection {
  return joinStreams(
    groupLines("stdout", capture.stdout, maxBytes, patterns, keyFor, perGroup),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function searchGroupKey(line: string): string {
  const match = /^([^:]+):/.exec(line);
  return match?.[1] ?? "match";
}

function isSummaryLine(line: string): boolean {
  return /fail|error|pass|ok |tests?|warning|error TS/i.test(line);
}
