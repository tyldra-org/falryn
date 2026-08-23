/** Hush-native semantic line policies shared by command-aware reducers. */

import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../../process-capture.ts";
import { binaryOmission, boundText, joinStreams, matchesPattern } from "../bounds.ts";
import type { HushStreamProjection } from "../contracts.ts";

type SemanticPolicy = {
  readonly detail: string;
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly headLines: number;
  readonly tailLines: number;
  readonly keep: readonly RegExp[];
  readonly noise: readonly RegExp[];
};

const FAILURE = /(?:\b(?:error|failed|failure|fatal|panic|traceback)\b|[✗✖⨯])/i;
const WARNING = /(?:\bwarn(?:ing)?\b|\bdeprecated\b)/i;
const SUMMARY =
  /(?:\b(?:passed|failed|errors?|warnings?|tests?|suites?|files?|changed|finished|complete|success|total|duration|done)\b|^\d+\s+(?:pass|fail))/i;
const LOCATION = /(?:^|\s)(?:[^\s:]+[/\\])?[^\s:]+:\d+(?::\d+)?/;
const HTTP_STATUS = /(?:^HTTP\/\d(?:\.\d)?\s+\d{3}\b|\bstatus(?: code)?[:=]\s*\d{3}\b)/i;

const POLICIES = {
  read: {
    detail: "Hush read sample",
    maxBytes: 2_048,
    maxLines: 28,
    headLines: 12,
    tailLines: 8,
    keep: [],
    noise: [],
  },
  test: {
    detail: "Hush failure-first test projection",
    maxBytes: 2_048,
    maxLines: 48,
    headLines: 3,
    tailLines: 10,
    keep: [FAILURE, WARNING, SUMMARY, LOCATION],
    noise: [/(?:^|\s)(?:PASS|ok)\b/i, /^\s*[.·]+\s*$/],
  },
  diagnostic: {
    detail: "Hush diagnostic projection",
    maxBytes: 2_048,
    maxLines: 48,
    headLines: 2,
    tailLines: 6,
    keep: [FAILURE, WARNING, SUMMARY, LOCATION],
    noise: [/^\s*$/, /(?:searching|scanning|checking)\s+\d+/i],
  },
  build: {
    detail: "Hush build projection",
    maxBytes: 2_048,
    maxLines: 40,
    headLines: 3,
    tailLines: 10,
    keep: [FAILURE, WARNING, SUMMARY, LOCATION],
    noise: [/(?:compiling|downloading|building)\s+[^:]+$/i, /^\s*\[[=>. ]+\]\s*$/],
  },
  package: {
    detail: "Hush package projection",
    maxBytes: 1_536,
    maxLines: 36,
    headLines: 3,
    tailLines: 8,
    keep: [
      FAILURE,
      WARNING,
      SUMMARY,
      /\b(?:added|audited|installed|removed|updated|upgraded|vulnerabilit(?:y|ies))\b/i,
    ],
    noise: [/(?:download|fetch|extract|resolve|progress)/i, /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/],
  },
  table: {
    detail: "Hush table sample",
    maxBytes: 1_536,
    maxLines: 28,
    headLines: 4,
    tailLines: 4,
    keep: [FAILURE, WARNING],
    noise: [/^\s*$/],
  },
  log: {
    detail: "Hush log sample",
    maxBytes: 1_536,
    maxLines: 36,
    headLines: 3,
    tailLines: 14,
    keep: [FAILURE, WARNING, SUMMARY],
    noise: [/^\s*$/],
  },
  network: {
    detail: "Hush network projection",
    maxBytes: 1_536,
    maxLines: 32,
    headLines: 5,
    tailLines: 8,
    keep: [FAILURE, WARNING, SUMMARY, HTTP_STATUS],
    noise: [/^\s*%\s+Total/i, /^\s*\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+/],
  },
  operation: {
    detail: "Hush operation projection",
    maxBytes: 1_536,
    maxLines: 36,
    headLines: 4,
    tailLines: 10,
    keep: [FAILURE, WARNING, SUMMARY, LOCATION],
    noise: [/^\s*$/, /(?:progress|waiting|spinner)/i],
  },
  structured: {
    detail: "Hush structured-data sample",
    maxBytes: 1_536,
    maxLines: 32,
    headLines: 8,
    tailLines: 6,
    keep: [FAILURE, WARNING, /(?:"(?:error|message|name|status|type)"\s*:)/i],
    noise: [/^\s*$/],
  },
} as const satisfies Readonly<Record<string, SemanticPolicy>>;

export type SemanticProjectionKind = keyof typeof POLICIES;

export function semanticProjection(
  kind: SemanticProjectionKind,
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  const policy = POLICIES[kind];
  const budget = Math.min(maxBytes, policy.maxBytes);
  return joinStreams(
    projectStream("stdout", capture.stdout, budget, patterns, policy),
    projectStream("stderr", capture.stderr, Math.min(budget, 1_024), patterns, policy),
    budget,
  );
}

function projectStream(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
  policy: SemanticPolicy,
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }
  const lines = splitLines(capture.inlineText);
  if (lines.length === 0) {
    return { text: "", omissions: [] };
  }
  const selected = selectLineIndices(lines, patterns, policy);
  const text = selected.map((index) => lines[index] ?? "").join("\n");
  const bounded = boundText(text, stream, maxBytes);
  const omitted = Math.max(0, lines.length - selected.length);
  return {
    text: bounded.text,
    omissions: [
      ...(omitted > 0
        ? [
            {
              kind: "capped-lines" as const,
              stream,
              count: omitted,
              detail: policy.detail,
            },
          ]
        : []),
      ...bounded.omissions,
    ],
  };
}

function selectLineIndices(
  lines: readonly string[],
  patterns: readonly string[],
  policy: SemanticPolicy,
): readonly number[] {
  if (lines.length <= policy.maxLines) {
    return lines.map((_, index) => index);
  }
  const selected = new Set<number>();
  addMatching(selected, lines, (line) => matchesPattern(line, patterns));
  addMatching(selected, lines, (line) => policy.keep.some((pattern) => pattern.test(line)));
  addRange(selected, 0, Math.min(lines.length, policy.headLines));
  addRange(selected, Math.max(0, lines.length - policy.tailLines), lines.length);

  const candidates = lines
    .map((line, index) => ({ index, line }))
    .filter(
      ({ index, line }) =>
        !selected.has(index) && !policy.noise.some((pattern) => pattern.test(line)),
    )
    .map(({ index }) => index);
  addEvenlySpaced(selected, candidates, Math.max(0, policy.maxLines - selected.size));
  return [...selected].sort((left, right) => left - right);
}

function addMatching(
  selected: Set<number>,
  lines: readonly string[],
  predicate: (line: string) => boolean,
): void {
  for (const [index, line] of lines.entries()) {
    if (predicate(line)) {
      selected.add(index);
    }
  }
}

function addRange(selected: Set<number>, start: number, end: number): void {
  for (let index = start; index < end; index += 1) {
    selected.add(index);
  }
}

function addEvenlySpaced(
  selected: Set<number>,
  candidates: readonly number[],
  limit: number,
): void {
  if (limit <= 0 || candidates.length === 0) {
    return;
  }
  if (candidates.length <= limit) {
    for (const candidate of candidates) {
      selected.add(candidate);
    }
    return;
  }
  for (let index = 0; index < limit; index += 1) {
    const position = Math.floor((index * candidates.length) / limit);
    const candidate = candidates[position];
    if (candidate !== undefined) {
      selected.add(candidate);
    }
  }
}

function splitLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
