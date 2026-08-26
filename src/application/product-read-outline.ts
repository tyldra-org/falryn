/** Index-informed, line-aware projections for oversized Product Read results. */

import type {
  WorkspaceFileRead,
  WorkspaceIndexGeneration,
  WorkspaceIndexRecord,
} from "../domain/index.ts";
import { indexLifecycleQueryable } from "../domain/index.ts";

export const INDEXED_READ_PROJECTION_KIND = "indexed-outline" as const;
export const MAX_INDEXED_READ_LINE_BYTES = 512;

export type IndexedReadOmission = {
  readonly startLine: number;
  readonly endLine: number;
};

export type IndexedReadProjection = {
  readonly kind: typeof INDEXED_READ_PROJECTION_KIND;
  readonly text: string;
  readonly byteLength: number;
  readonly sourceBytes: number;
  readonly generation: string;
  readonly schema: string;
  readonly selectedLines: readonly number[];
  readonly omissions: readonly IndexedReadOmission[];
};

type OutlineLine = {
  readonly line: number;
  readonly text: string;
  readonly symbolRange: { readonly start: number; readonly end: number } | null;
};

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maximum: number): string {
  if (byteLength(value) <= maximum) {
    return value;
  }
  const ellipsis = "…";
  const ellipsisBytes = byteLength(ellipsis);
  if (maximum <= ellipsisBytes) {
    return "";
  }
  let output = "";
  let used = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (used + characterBytes + ellipsisBytes > maximum) {
      break;
    }
    output += character;
    used += characterBytes;
  }
  return `${output}${ellipsis}`;
}

function preferredRecord(
  current: WorkspaceIndexRecord | undefined,
  candidate: WorkspaceIndexRecord,
): WorkspaceIndexRecord {
  if (current === undefined) {
    return candidate;
  }
  const priority = { symbol: 3, heading: 2, chunk: 1 } as const;
  return priority[candidate.kind] > priority[current.kind] ? candidate : current;
}

function structuralPriority(record: WorkspaceIndexRecord): number {
  if (record.kind === "heading") {
    return 4;
  }
  return /\b(?:function|class|interface|type|enum)\b/.test(record.text) ? 3 : 1;
}

function omissionText(omission: IndexedReadOmission): string {
  return omission.startLine === omission.endLine
    ? `… line ${omission.startLine} omitted …`
    : `… lines ${omission.startLine}-${omission.endLine} omitted …`;
}

function omissionsFor(lines: readonly OutlineLine[], sourceLines: number): IndexedReadOmission[] {
  const omissions: IndexedReadOmission[] = [];
  let next = 1;
  for (const line of lines) {
    if (line.line > next) {
      omissions.push({ startLine: next, endLine: line.line - 1 });
    }
    next = line.line + 1;
  }
  if (next <= sourceLines) {
    omissions.push({ startLine: next, endLine: sourceLines });
  }
  return omissions;
}

function render(
  logical: string,
  lines: readonly OutlineLine[],
  sourceLines: number,
): { readonly text: string; readonly omissions: readonly IndexedReadOmission[] } {
  const omissions = omissionsFor(lines, sourceLines);
  const omissionByStart = new Map(omissions.map((omission) => [omission.startLine, omission]));
  const width = String(sourceLines).length;
  const output = [`${logical} [indexed outline; exact source via loomRecovery]`];
  let next = 1;
  for (const line of lines) {
    const omission = omissionByStart.get(next);
    if (omission !== undefined) {
      output.push(omissionText(omission));
    }
    const range =
      line.symbolRange !== null && line.symbolRange.end > line.symbolRange.start
        ? ` [symbol lines ${line.symbolRange.start}-${line.symbolRange.end}]`
        : "";
    output.push(`${String(line.line).padStart(width, " ")} | ${line.text}${range}`);
    next = line.line + 1;
  }
  const finalOmission = omissionByStart.get(next);
  if (finalOmission !== undefined) {
    output.push(omissionText(finalOmission));
  }
  return { text: output.join("\n"), omissions };
}

function outlineRecords(records: readonly WorkspaceIndexRecord[]): {
  readonly boundaries: readonly WorkspaceIndexRecord[];
  readonly structural: readonly WorkspaceIndexRecord[];
  readonly sourceLines: number;
} {
  const ordered = [...records].sort(
    (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
  );
  const chunks = ordered.filter((record) => record.kind === "chunk");
  const boundaries = [...chunks.slice(0, 2), ...chunks.slice(-2)];
  return {
    boundaries,
    structural: ordered
      .filter((record) => record.kind !== "chunk")
      .sort(
        (left, right) =>
          structuralPriority(right) - structuralPriority(left) || left.startLine - right.startLine,
      ),
    sourceLines: ordered.reduce((maximum, record) => Math.max(maximum, record.endLine), 0),
  };
}

/**
 * Builds a bounded source outline only when the index record is digest-bound to
 * the exact artifact retained by Read. Missing, stale, or structure-free index
 * data returns null so Product Read can use Loom's byte-safe head/tail fallback.
 */
export function projectIndexedRead(
  read: WorkspaceFileRead,
  generation: WorkspaceIndexGeneration,
  maximumBytes: number,
): IndexedReadProjection | null {
  if (!indexLifecycleQueryable(generation.lifecycle) || maximumBytes < 256) {
    return null;
  }
  const revision = String(read.digest);
  const records = generation.records.filter(
    (record) => record.logical === read.bound.logical && record.revision === revision,
  );
  const groups = outlineRecords(records);
  if (groups.structural.length === 0 || groups.sourceLines === 0) {
    return null;
  }

  const selected = new Map<number, WorkspaceIndexRecord>();
  const additions: number[] = [];
  const add = (record: WorkspaceIndexRecord): void => {
    const existing = selected.get(record.startLine);
    const next = preferredRecord(existing, record);
    selected.set(record.startLine, next);
    if (existing === undefined) {
      additions.push(record.startLine);
    }
  };
  for (const record of groups.boundaries) {
    add(record);
  }

  const reservedBytes = 192;
  let estimatedBytes = reservedBytes;
  for (const record of groups.structural) {
    const line = truncateUtf8(record.text, MAX_INDEXED_READ_LINE_BYTES);
    const estimatedLineBytes = byteLength(line) + 80;
    if (estimatedBytes + estimatedLineBytes > maximumBytes) {
      continue;
    }
    add(record);
    estimatedBytes += estimatedLineBytes;
  }

  const toLines = (): OutlineLine[] =>
    [...selected.values()]
      .sort((left, right) => left.startLine - right.startLine)
      .map((record) => ({
        line: record.startLine,
        text: truncateUtf8(record.text, MAX_INDEXED_READ_LINE_BYTES),
        symbolRange:
          record.kind === "symbol" ? { start: record.startLine, end: record.endLine } : null,
      }));

  let lines = toLines();
  let rendered = render(read.bound.logical, lines, groups.sourceLines);
  const boundaryLines = new Set(groups.boundaries.map((record) => record.startLine));
  while (byteLength(rendered.text) > maximumBytes) {
    const removable = additions.findLast((line) => !boundaryLines.has(line));
    if (removable === undefined) {
      return null;
    }
    selected.delete(removable);
    additions.splice(additions.lastIndexOf(removable), 1);
    lines = toLines();
    rendered = render(read.bound.logical, lines, groups.sourceLines);
  }

  return {
    kind: INDEXED_READ_PROJECTION_KIND,
    text: rendered.text,
    byteLength: byteLength(rendered.text),
    sourceBytes: read.expansion?.byteLength ?? read.byteLength,
    generation: generation.id,
    schema: generation.schema,
    selectedLines: lines.map((line) => line.line),
    omissions: rendered.omissions,
  };
}
