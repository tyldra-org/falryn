/** Listing-family reducers, including the compact deterministic `ls` sampler. */

import type {
  ProcessCaptureReport,
  ProcessStreamCapture,
  ProcessStreamName,
} from "../../process-capture.ts";
import {
  binaryOmission,
  boundStream,
  boundText,
  groupLines,
  joinStreams,
  matchesPattern,
} from "../bounds.ts";
import type { HushStreamProjection } from "../contracts.ts";

/** Specialized ls projection cap; the exact capture remains recoverable. */
const LS_MAX_REDUCED_BYTES = 384;
const LS_MAX_RETAINED_LINES = 10;
const LS_MAX_RETAINED_ANCHORS = 4;

export function listingProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    groupLines("stdout", capture.stdout, maxBytes, patterns, () => "entry", 32),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

export function lsProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  return joinStreams(
    sampleLsOutput("stdout", capture.stdout, maxBytes, patterns),
    boundStream("stderr", capture.stderr, Math.min(maxBytes, 4_096), patterns, true),
    maxBytes,
  );
}

function sampleLsOutput(
  stream: ProcessStreamName,
  capture: ProcessStreamCapture,
  maxBytes: number,
  patterns: readonly string[],
): HushStreamProjection {
  if (capture.encoding === "binary" || capture.inlineText === null) {
    return binaryOmission(stream, capture);
  }

  const lines = listingLines(capture.inlineText);
  const listingBudget = patterns.length > 0 ? maxBytes : Math.min(maxBytes, LS_MAX_REDUCED_BYTES);
  const sample = fitLsSample(lines, patterns, listingBudget);
  if (
    sample.omitted === 0 &&
    new TextEncoder().encode(capture.inlineText).byteLength <= listingBudget
  ) {
    return { text: capture.inlineText, omissions: [] };
  }
  const bounded = boundText(sample.text, stream, listingBudget);
  return {
    text: bounded.text,
    omissions: [
      ...(sample.omitted > 0
        ? [
            {
              kind: "capped-lines" as const,
              stream,
              count: sample.omitted,
              detail: "deterministic ls sample",
            },
          ]
        : []),
      ...bounded.omissions,
    ],
  };
}

function fitLsSample(
  lines: readonly string[],
  patterns: readonly string[],
  maxBytes: number,
): Readonly<{ text: string; omitted: number }> {
  if (lines.length <= 1) {
    return { text: lines[0] ?? "", omitted: 0 };
  }
  for (
    let retainedLimit = Math.min(LS_MAX_RETAINED_LINES, lines.length);
    retainedLimit >= 0;
    retainedLimit -= 1
  ) {
    const selected = selectLsLineIndices(lines, patterns, retainedLimit);
    const retained = selected.map((index) => lines[index]);
    const omitted = Math.max(0, lines.length - retained.length);
    const summary = omitted > 0 ? [`ls: ${lines.length} lines, ${omitted} omitted`] : [];
    const text = [...summary, ...retained].join("\n");
    if (new TextEncoder().encode(text).byteLength <= maxBytes || retainedLimit === 0) {
      return { text, omitted };
    }
  }
  return { text: "", omitted: lines.length };
}

function selectLsLineIndices(
  lines: readonly string[],
  patterns: readonly string[],
  retainedLimit: number,
): readonly number[] {
  const important = lineIndices(lines, (line) => matchesPattern(line, patterns));
  const anchors = lineIndices(lines, isLsAnchor);
  const selected = new Set(important);
  const anchorBudget = Math.min(
    LS_MAX_RETAINED_ANCHORS,
    Math.max(0, retainedLimit - selected.size),
  );
  addEvenlySpaced(selected, anchors, anchorBudget);
  addEvenlySpaced(
    selected,
    lines.map((_, index) => index),
    Math.max(0, retainedLimit - selected.size),
  );
  return [...selected].sort((left, right) => left - right);
}

function listingLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function lineIndices(
  lines: readonly string[],
  predicate: (line: string) => boolean,
): readonly number[] {
  const indices: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (predicate(line)) {
      indices.push(index);
    }
  }
  return indices;
}

function isLsAnchor(line: string): boolean {
  return line.endsWith(":") || /^total\s+\d+$/.test(line);
}

function addEvenlySpaced(
  selected: Set<number>,
  candidates: readonly number[],
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }
  const available = candidates.filter((candidate) => !selected.has(candidate));
  if (available.length <= limit) {
    for (const candidate of available) {
      selected.add(candidate);
    }
    return;
  }
  if (limit === 1) {
    const first = available[0];
    if (first !== undefined) {
      selected.add(first);
    }
    return;
  }
  for (let index = 0; index < limit; index += 1) {
    const position = Math.round((index * (available.length - 1)) / (limit - 1));
    const candidate = available[position];
    if (candidate !== undefined) {
      selected.add(candidate);
    }
  }
}
