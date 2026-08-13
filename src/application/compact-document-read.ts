/**
 * Application boundary for the bounded compact document reader (#493).
 *
 * The only byte source is the injected workspace reader. Extraction is
 * deterministic and provider/UI independent.
 */

import {
  assertNever,
  type CompactDocumentDocument,
  type CompactDocumentEmptyReason,
  type CompactDocumentExtraction,
  type CompactDocumentHeading,
  type CompactDocumentMode,
  type CompactDocumentOmission,
  type CompactDocumentRange,
  type CompactDocumentRead,
  type CompactDocumentReadError,
  type CompactDocumentSpan,
  type CompactDocumentSpanKind,
  compactDocumentFamily,
  extractCompactDocumentHeadings,
  type LineRange,
  type LocalPath,
  type NumberedLine,
  parseCompactDocumentReadRequest,
} from "../domain/index.ts";
import type { WorkspaceReader } from "./workspace-read.ts";

export type CompactDocumentReader = {
  read(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: CompactDocumentRead }
    | { readonly ok: false; readonly error: CompactDocumentReadError }
  >;
};

type Candidate = {
  readonly kind: CompactDocumentSpanKind;
  readonly label: string | null;
  readonly sourceRange: LineRange;
  readonly headingPath: readonly string[];
  readonly symbolPath: readonly string[];
  readonly recoveryRange: LineRange | null;
};

type Selection = {
  readonly candidates: readonly Candidate[];
  readonly selectedRanges: readonly LineRange[];
  readonly emptyReason: CompactDocumentEmptyReason | null;
};

type Rendered = {
  readonly spans: readonly CompactDocumentSpan[];
  readonly omissions: readonly CompactDocumentOmission[];
  readonly recoveryRanges: readonly LineRange[];
  readonly exhaustedBudget: "output-bytes" | "output-lines" | null;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function lineCount(lines: readonly NumberedLine[], byteLength: number): number {
  return byteLength === 0 ? 0 : lines.length;
}

function linesForRange(lines: readonly NumberedLine[], range: LineRange): readonly NumberedLine[] {
  return lines.filter((line) => line.number >= range.start && line.number <= range.end);
}

function rangeForLines(lines: readonly NumberedLine[]): LineRange | null {
  const first = lines[0];
  const last = lines.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  return { start: first.number, end: last.number };
}

function mergeRanges(ranges: readonly LineRange[]): readonly LineRange[] {
  const ordered = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: LineRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end + 1) {
      merged.push({ ...range });
      continue;
    }
    merged[merged.length - 1] = { ...previous, end: Math.max(previous.end, range.end) };
  }
  return merged;
}

function complementRanges(lineTotal: number, selected: readonly LineRange[]): readonly LineRange[] {
  if (lineTotal === 0) {
    return [];
  }
  const clipped = selected
    .map((range) => ({
      start: Math.max(1, range.start),
      end: Math.min(lineTotal, range.end),
    }))
    .filter((range) => range.start <= range.end);
  const merged = mergeRanges(clipped);
  const result: LineRange[] = [];
  let next = 1;
  for (const range of merged) {
    if (range.start > next) {
      result.push({ start: next, end: range.start - 1 });
    }
    next = Math.max(next, range.end + 1);
  }
  if (next <= lineTotal) {
    result.push({ start: next, end: lineTotal });
  }
  return result;
}

function linesInRanges(ranges: readonly LineRange[]): number {
  return ranges.reduce((total, range) => total + range.end - range.start + 1, 0);
}

function contextForLine(
  headings: readonly CompactDocumentHeading[],
  line: number,
): Pick<Candidate, "headingPath" | "symbolPath"> {
  let current: CompactDocumentHeading | undefined;
  for (const heading of headings) {
    if (heading.range.start > line) {
      break;
    }
    current = heading;
  }
  return {
    headingPath: current?.headingPath ?? [],
    symbolPath: current?.symbolPath ?? [],
  };
}

function sectionRecoveryRange(
  heading: CompactDocumentHeading,
  headings: readonly CompactDocumentHeading[],
  totalLines: number,
): LineRange | null {
  const next = headings.find(
    (candidate) => candidate.range.start > heading.range.start && candidate.level <= heading.level,
  );
  const end = (next?.range.start ?? totalLines + 1) - 1;
  return end > heading.range.end ? { start: heading.range.start, end } : null;
}

function candidateForRange(
  range: CompactDocumentRange,
  lines: readonly NumberedLine[],
  headings: readonly CompactDocumentHeading[],
): Candidate | null {
  const selected = linesForRange(lines, { start: range.start, end: range.end });
  const sourceRange = rangeForLines(selected);
  if (sourceRange === null) {
    return null;
  }
  const context = contextForLine(headings, sourceRange.start);
  return {
    kind: range.kind,
    label: range.label,
    sourceRange,
    ...context,
    recoveryRange: null,
  };
}

function relevantRanges(
  lines: readonly NumberedLine[],
  query: string,
  contextLines: number,
): readonly LineRange[] {
  const normalized = query.toLowerCase();
  return mergeRanges(
    lines
      .filter((line) => line.text.toLowerCase().includes(normalized))
      .map((line) => ({
        start: Math.max(1, line.number - contextLines),
        end: Math.min(lines.length, line.number + contextLines),
      })),
  );
}

function selectCandidates(
  mode: CompactDocumentMode,
  lines: readonly NumberedLine[],
  headings: readonly CompactDocumentHeading[],
  ranges: readonly CompactDocumentRange[],
  headLines: number,
  tailLines: number,
  query: string | null,
  contextLines: number,
): Selection {
  const totalLines = lines.length;
  switch (mode) {
    case "outline":
      return {
        candidates: headings.map((heading) => ({
          kind: heading.kind,
          label: heading.title,
          sourceRange: heading.range,
          headingPath: heading.headingPath,
          symbolPath: heading.symbolPath,
          recoveryRange: sectionRecoveryRange(heading, headings, totalLines),
        })),
        selectedRanges: headings.map((heading) => heading.range),
        emptyReason: "no-headings",
      };
    case "ranges":
      return {
        candidates: ranges.flatMap((range) => {
          const candidate = candidateForRange(range, lines, headings);
          return candidate === null ? [] : [candidate];
        }),
        selectedRanges: ranges.map((range) => range),
        emptyReason: "no-range-content",
      };
    case "head-tail": {
      const requested: LineRange[] = [];
      if (headLines > 0 && totalLines > 0) {
        requested.push({ start: 1, end: Math.min(totalLines, headLines) });
      }
      if (tailLines > 0 && totalLines > 0) {
        requested.push({
          start: Math.max(1, totalLines - tailLines + 1),
          end: totalLines,
        });
      }
      return {
        candidates: mergeRanges(requested).flatMap((range) => {
          const context = contextForLine(headings, range.start);
          return [
            {
              kind: "section",
              label: null,
              sourceRange: range,
              ...context,
              recoveryRange: null,
            },
          ];
        }),
        selectedRanges: requested,
        emptyReason: null,
      };
    }
    case "relevant": {
      if (query === null) {
        return { candidates: [], selectedRanges: [], emptyReason: "no-matches" };
      }
      const selected = relevantRanges(lines, query, contextLines);
      return {
        candidates: selected.map((range) => ({
          kind: "relevant",
          label: query,
          sourceRange: range,
          ...contextForLine(headings, range.start),
          recoveryRange: null,
        })),
        selectedRanges: selected,
        emptyReason: "no-matches",
      };
    }
    default:
      return assertNever(mode, "unhandled compact document mode");
  }
}

function omission(
  kind: CompactDocumentOmission["kind"],
  count: number,
  range: LineRange | null,
): CompactDocumentOmission | null {
  return count > 0 ? { kind, count, range } : null;
}

function addOmission(
  omissions: CompactDocumentOmission[],
  kind: CompactDocumentOmission["kind"],
  count: number,
  range: LineRange | null,
): void {
  const value = omission(kind, count, range);
  if (value !== null) {
    omissions.push(value);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = maxBytes; length > 0; length -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, length));
    } catch {}
  }
  return "";
}

function renderCandidates(
  candidates: readonly Candidate[],
  lines: readonly NumberedLine[],
  limits: {
    readonly maxOutputBytes: number;
    readonly maxOutputLines: number;
    readonly maxSpans: number;
  },
  initialOmissions: readonly CompactDocumentOmission[],
  initialRecoveryRanges: readonly LineRange[],
): Rendered {
  const omissions = [...initialOmissions];
  const recoveryRanges = [...initialRecoveryRanges];
  const spans: CompactDocumentSpan[] = [];
  let outputBytes = 0;
  let outputLines = 0;
  let exhaustedBudget: Rendered["exhaustedBudget"] = null;

  const admitted = candidates.slice(0, limits.maxSpans);
  if (candidates.length > admitted.length) {
    addOmission(omissions, "spans", candidates.length - admitted.length, null);
    for (const candidate of candidates.slice(admitted.length)) {
      recoveryRanges.push(candidate.recoveryRange ?? candidate.sourceRange);
    }
  }

  for (const candidate of admitted) {
    const candidateLines = linesForRange(lines, candidate.sourceRange);
    const availableLines = limits.maxOutputLines - outputLines;
    const availableBytes = limits.maxOutputBytes - outputBytes;
    if (availableLines <= 0) {
      addOmission(omissions, "spans", 1, candidate.sourceRange);
      addOmission(omissions, "lines", candidateLines.length, candidate.sourceRange);
      recoveryRanges.push(candidate.recoveryRange ?? candidate.sourceRange);
      exhaustedBudget ??= "output-lines";
      continue;
    }
    if (availableBytes <= 0) {
      addOmission(omissions, "spans", 1, candidate.sourceRange);
      addOmission(omissions, "lines", candidateLines.length, candidate.sourceRange);
      recoveryRanges.push(candidate.recoveryRange ?? candidate.sourceRange);
      exhaustedBudget ??= "output-bytes";
      continue;
    }

    const visibleLines = candidateLines.slice(0, availableLines);
    const visibleText = visibleLines.map((line) => line.text).join("\n");
    const visibleBytes = Buffer.byteLength(visibleText, "utf8");
    const byteTruncated = visibleBytes > availableBytes;
    const text = byteTruncated ? truncateUtf8(visibleText, availableBytes) : visibleText;
    const includedLineCount =
      byteTruncated && text === ""
        ? 0
        : byteTruncated
          ? text.split("\n").length
          : visibleLines.length;
    const lastVisibleLine = visibleLines[includedLineCount - 1];
    if (lastVisibleLine === undefined) {
      addOmission(omissions, "spans", 1, candidate.sourceRange);
      addOmission(omissions, "lines", candidateLines.length, candidate.sourceRange);
      recoveryRanges.push(candidate.recoveryRange ?? candidate.sourceRange);
      exhaustedBudget ??= byteTruncated ? "output-bytes" : "output-lines";
      continue;
    }

    const emittedBytes = Buffer.byteLength(text, "utf8");
    const sourceRange = {
      start: candidate.sourceRange.start,
      end: lastVisibleLine.number,
    };
    spans.push({
      kind: candidate.kind,
      label: candidate.label,
      sourceRange,
      text,
      headingPath: candidate.headingPath,
      symbolPath: candidate.symbolPath,
      truncated:
        byteTruncated ||
        includedLineCount < candidateLines.length ||
        candidate.recoveryRange !== null,
    });
    outputBytes += emittedBytes;
    outputLines += includedLineCount;

    const omittedLines = candidateLines.length - includedLineCount;
    addOmission(
      omissions,
      "lines",
      omittedLines,
      omittedLines > 0
        ? { start: lastVisibleLine.number + 1, end: candidate.sourceRange.end }
        : null,
    );
    addOmission(
      omissions,
      "bytes",
      Math.max(0, visibleBytes - emittedBytes),
      byteTruncated ? sourceRange : null,
    );
    if (omittedLines > 0 || byteTruncated) {
      recoveryRanges.push(
        omittedLines > 0
          ? { start: lastVisibleLine.number + 1, end: candidate.sourceRange.end }
          : candidate.sourceRange,
      );
    }
    if (candidate.recoveryRange !== null) {
      recoveryRanges.push(candidate.recoveryRange);
    }
  }

  return {
    spans,
    omissions,
    recoveryRanges: mergeRanges(recoveryRanges).slice(0, limits.maxSpans),
    exhaustedBudget,
  };
}

function extractionFor(mode: CompactDocumentMode): CompactDocumentExtraction {
  switch (mode) {
    case "outline":
      return "outline";
    case "ranges":
      return "explicit-ranges";
    case "head-tail":
      return "head-tail";
    case "relevant":
      return "relevant-spans";
    default:
      return assertNever(mode, "unhandled compact document extraction");
  }
}

function documentIdentity(
  requested: string,
  bound: CompactDocumentDocument["bound"],
  family: CompactDocumentDocument["family"],
  byteLength: number,
  newline: CompactDocumentDocument["newline"],
): CompactDocumentDocument {
  return { requested, bound, family, byteLength, newline };
}

function emptyResult(
  request: {
    readonly mode: CompactDocumentMode;
    readonly path: string;
  },
  document: CompactDocumentDocument,
  reason: CompactDocumentEmptyReason,
  omissions: readonly CompactDocumentOmission[],
  recoveryRanges: readonly LineRange[],
): CompactDocumentRead {
  return {
    capability: "read_compact",
    status: "empty",
    projection: "compact",
    complete: false,
    mode: request.mode,
    extraction: extractionFor(request.mode),
    document,
    spans: [],
    omissions,
    recoveryRanges,
    emptyReason: reason,
  };
}

async function readCompact(
  workspaceReader: WorkspaceReader,
  root: LocalPath,
  request: unknown,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: CompactDocumentRead }
  | { readonly ok: false; readonly error: CompactDocumentReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const parsed = parseCompactDocumentReadRequest(request);
  if (!parsed.ok) {
    return parsed;
  }
  const source = await workspaceReader.read(
    root,
    parsed.value.path,
    undefined,
    { maxFileBytes: parsed.value.limits.maxSourceBytes },
    signal,
  );
  if (!source.ok) {
    return { ok: false, error: source.error };
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }

  const lines = source.value.lines;
  const totalLines = lineCount(lines, source.value.byteLength);
  const family = compactDocumentFamily(source.value.bound.logical);
  const document = documentIdentity(
    parsed.value.path,
    source.value.bound,
    family,
    source.value.byteLength,
    source.value.newline,
  );
  if (totalLines === 0) {
    return {
      ok: true,
      value: emptyResult(parsed.value, document, "empty-source", [], []),
    };
  }

  const headings = extractCompactDocumentHeadings(lines, family);
  const selection = selectCandidates(
    parsed.value.mode,
    lines,
    headings,
    parsed.value.ranges,
    parsed.value.headLines,
    parsed.value.tailLines,
    parsed.value.query,
    parsed.value.limits.maxContextLines,
  );
  const omittedRanges = complementRanges(totalLines, selection.selectedRanges);
  const initialOmissions: CompactDocumentOmission[] = [];
  addOmission(
    initialOmissions,
    "lines",
    linesInRanges(omittedRanges),
    omittedRanges.length === 1 ? (omittedRanges[0] ?? null) : null,
  );
  const rendered = renderCandidates(
    selection.candidates,
    lines,
    parsed.value.limits,
    initialOmissions,
    omittedRanges,
  );
  if (rendered.exhaustedBudget !== null && rendered.spans.length === 0) {
    return {
      ok: false,
      error: { code: "budget-exhausted", budget: rendered.exhaustedBudget },
    };
  }
  if (rendered.spans.length === 0) {
    return {
      ok: true,
      value: emptyResult(
        parsed.value,
        document,
        selection.emptyReason ?? "no-matches",
        rendered.omissions,
        rendered.recoveryRanges,
      ),
    };
  }
  return {
    ok: true,
    value: {
      capability: "read_compact",
      status: rendered.omissions.length > 0 ? "partial" : "complete",
      projection: "compact",
      complete: false,
      mode: parsed.value.mode,
      extraction: extractionFor(parsed.value.mode),
      document,
      spans: rendered.spans,
      omissions: rendered.omissions,
      recoveryRanges: rendered.recoveryRanges,
    },
  };
}

export function createCompactDocumentReader(
  workspaceReader: WorkspaceReader,
): CompactDocumentReader {
  return {
    read(root, request, signal) {
      return readCompact(workspaceReader, root, request, signal);
    },
  };
}
