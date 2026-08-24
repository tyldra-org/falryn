/** Uncapped Hush-native compaction shared by semantic command families. */

import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../../process-capture.ts";
import { binaryOmission, boundText, joinStreams, matchesPattern } from "../bounds.ts";
import type { HushStreamProjection } from "../contracts.ts";
import {
  compactDuplicateRuns,
  compactJsonWhitespace,
  shortestText,
  stripAnsi,
} from "../text-format.ts";

export const SEMANTIC_PROJECTION_KINDS = [
  "read",
  "test",
  "diagnostic",
  "build",
  "package",
  "table",
  "log",
  "network",
  "operation",
  "structured",
] as const;

export type SemanticProjectionKind = (typeof SEMANTIC_PROJECTION_KINDS)[number];

export function semanticProjection(
  kind: SemanticProjectionKind,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    semanticStreamProjection(kind, "stdout", capture.stdout, maxBytes, patterns),
    semanticStreamProjection(kind, "stderr", capture.stderr, maxBytes, patterns),
    maxBytes,
  );
}

export function semanticStreamProjection(
  kind: SemanticProjectionKind,
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }

  const plain = stripAnsi(capture.inlineText);
  const filtered = filterSemanticNoise(kind, plain, patterns);
  const summary = kind === "test" ? compactTestDuration(filtered) : null;
  const duplicateCompaction = compactDuplicateRuns(filtered, (line) =>
    matchesPattern(line, patterns),
  );
  const jsonCompaction =
    kind === "structured" || kind === "network" ? compactJsonWhitespace(plain) : null;
  const projected = shortestText(
    plain,
    filtered,
    duplicateCompaction,
    ...(summary === null ? [] : [summary]),
    ...(jsonCompaction === null ? [] : [jsonCompaction]),
  );
  return boundText(projected, stream, maxBytes);
}

function compactTestDuration(text: string): string | null {
  const compact = text.replace(/\s+in\s+(\d+(?:\.\d+)?s)(?=\s*$)/u, " $1");
  return compact === text ? null : compact;
}

const SEMANTIC_NOISE: Readonly<Partial<Record<SemanticProjectionKind, readonly RegExp[]>>> = {
  test: [/^\s*(?:PASS(?:ED)?|ok)\b/iu, /\bPASSED\s*$/u, /^\s*[.·]+\s*$/u],
  diagnostic: [/^\s*(?:searching|scanning|checking)\s+\d+/iu],
  build: [/^\s*(?:compiling|downloading|building|checking)\s+[^:]+$/iu, /^\s*\[[=>. ]+\]\s*$/u],
  package: [
    /^\s*(?:download|fetch|extract|resolve|progress)\b/iu,
    /^\s*\d+\s+packages?\s+(?:is|are)\s+looking\s+for\s+funding/iu,
    /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u,
  ],
  network: [/^\s*%\s+Total\b/iu, /^\s*\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/u],
  operation: [
    /^\s*(?:refreshing state|acquiring state lock|releasing state lock)\b/iu,
    /^\s*(?:progress|waiting|spinner)\b/iu,
  ],
};

function filterSemanticNoise(
  kind: SemanticProjectionKind,
  text: string,
  patterns: readonly string[],
): string {
  const noise = SEMANTIC_NOISE[kind] ?? [];
  if (noise.length === 0) {
    return text;
  }
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  const filtered = lines.filter(
    (line) => matchesPattern(line, patterns) || !noise.some((pattern) => pattern.test(line)),
  );
  const result = filtered.join("\n");
  return trailingNewline ? `${result}\n` : result;
}
