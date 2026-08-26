/** Plain-text compaction shared by command families without a dedicated parser. */

import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../../process-capture.ts";
import type { HushStreamProjection } from "../contracts.ts";
import {
  compactDuplicateRuns,
  compactJsonWhitespace,
  shortestText,
  stripAnsi,
} from "./shared/text.ts";
import { binaryOmission, boundText, joinStreams, matchesPattern } from "./stream.ts";

export const HUSH_PLAIN_TEXT_KINDS = [
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

export type HushPlainTextKind = (typeof HUSH_PLAIN_TEXT_KINDS)[number];

export function plainTextProjection(
  kind: HushPlainTextKind,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    plainTextStreamProjection(kind, "stdout", capture.stdout, maxBytes, patterns),
    plainTextStreamProjection(kind, "stderr", capture.stderr, maxBytes, patterns),
    maxBytes,
  );
}

export function plainTextStreamProjection(
  kind: HushPlainTextKind,
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }

  const plain = stripAnsi(capture.inlineText);
  const filtered = filterPlainTextNoise(kind, plain, patterns);
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

const PLAIN_TEXT_NOISE: Readonly<Partial<Record<HushPlainTextKind, readonly RegExp[]>>> = {
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

function filterPlainTextNoise(
  kind: HushPlainTextKind,
  text: string,
  patterns: readonly string[],
): string {
  const noise = PLAIN_TEXT_NOISE[kind] ?? [];
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
