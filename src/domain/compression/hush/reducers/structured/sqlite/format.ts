/** Complete compaction for validated SQLite CLI result shapes. */

export function formatSqliteResult(source: string): string | null {
  if (source.includes("\t") || source.includes("\r")) {
    return null;
  }
  return (
    formatSqliteColumnTable(source) ??
    formatSqliteBorderedTable(source) ??
    formatSqliteMarkdownTable(source) ??
    formatSqliteLineRecords(source)
  );
}

export function formatSqliteColumnTable(source: string): string | null {
  const split = splitSource(source);
  if (split.lines.length < 3 || split.lines.some((line) => /[^\x20-\x7e]/u.test(line))) {
    return null;
  }
  const ranges = parseColumnSeparator(split.lines[1] ?? "");
  const dataLines = split.lines.slice(2);
  if (ranges === null || dataLines.some((line) => parseColumnSeparator(line) !== null)) {
    return null;
  }
  const rows = [split.lines[0] ?? "", ...dataLines].map((line) => parseColumnRow(line, ranges));
  if (rows.some((row) => row === null)) {
    return null;
  }
  return renderRows(
    rows.filter((row): row is readonly string[] => row !== null),
    split.trailingNewline,
  );
}

export function formatSqliteBorderedTable(source: string): string | null {
  const split = splitSource(source);
  return (
    formatBorderedRows(split, {
      top: ["+", "+", "+", "-"],
      middle: ["+", "+", "+", "-"],
      bottom: ["+", "+", "+", "-"],
      row: "|",
    }) ??
    formatBorderedRows(split, {
      top: ["┌", "┬", "┐", "─"],
      middle: ["├", "┼", "┤", "─"],
      bottom: ["└", "┴", "┘", "─"],
      row: "│",
    })
  );
}

export function formatSqliteMarkdownTable(source: string): string | null {
  const split = splitSource(source);
  if (split.lines.length < 3) {
    return null;
  }
  const header = parseDelimitedRow(split.lines[0] ?? "", "|");
  const separator = parseMarkdownSeparator(split.lines[1] ?? "");
  if (header === null || separator === null || header.length !== separator) {
    return null;
  }
  const dataLines = split.lines.slice(2);
  if (dataLines.some((line) => parseMarkdownSeparator(line) !== null)) {
    return null;
  }
  const rows = dataLines.map((line) => parseDelimitedRow(line, "|"));
  if (rows.some((row) => row === null || row.length !== header.length)) {
    return null;
  }
  return renderRows(
    [header, ...rows.filter((row): row is readonly string[] => row !== null)],
    split.trailingNewline,
  );
}

export function formatSqliteLineRecords(source: string): string | null {
  const split = splitSource(source);
  if (split.lines.length < 2) {
    return null;
  }

  const records: (readonly LineCell[])[] = [];
  let cells: LineCell[] = [];
  for (const line of split.lines) {
    if (line.length === 0) {
      if (cells.length === 0) {
        return null;
      }
      records.push(cells);
      cells = [];
      continue;
    }
    const cell = parseLineCell(line);
    if (cell === null || cells.some((existing) => existing.key === cell.key)) {
      return null;
    }
    cells.push(cell);
  }
  if (cells.length > 0) {
    records.push(cells);
  }
  if (records.length === 0) {
    return null;
  }

  const header = records[0]?.map((cell) => cell.key) ?? [];
  if (
    header.length === 0 ||
    header.includes("record") ||
    records.some(
      (record) =>
        record.length !== header.length || record.some((cell, index) => cell.key !== header[index]),
    )
  ) {
    return null;
  }
  return renderRows(
    [
      ["record", ...header],
      ...records.map((record, index) => [String(index + 1), ...record.map((cell) => cell.value)]),
    ],
    split.trailingNewline,
  );
}

type SourceLines = Readonly<{ lines: readonly string[]; trailingNewline: boolean }>;
type ColumnRange = Readonly<{ start: number; end: number }>;
type LineCell = Readonly<{ key: string; value: string }>;
type Border = readonly [left: string, join: string, right: string, fill: string];
type BorderStyle = Readonly<{ top: Border; middle: Border; bottom: Border; row: string }>;

function splitSource(source: string): SourceLines {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function renderRows(rows: readonly (readonly string[])[], trailingNewline: boolean): string {
  const result = rows.map((row) => row.join("\t")).join("\n");
  return trailingNewline ? `${result}\n` : result;
}

function parseColumnSeparator(line: string): readonly ColumnRange[] | null {
  if (!/^-+(?: {2}-+)*$/u.test(line)) {
    return null;
  }
  const ranges: ColumnRange[] = [];
  for (const match of line.matchAll(/-+/gu)) {
    const start = match.index;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges.length > 0 ? ranges : null;
}

function parseColumnRow(line: string, ranges: readonly ColumnRange[]): readonly string[] | null {
  const cells: string[] = [];
  for (const [index, range] of ranges.entries()) {
    const next = ranges[index + 1];
    if (next !== undefined && !/^ *$/u.test(line.slice(range.end, next.start))) {
      return null;
    }
    cells.push(line.slice(range.start, range.end).trim());
  }
  const finalEnd = ranges.at(-1)?.end ?? 0;
  return /^ *$/u.test(line.slice(finalEnd)) ? cells : null;
}

function formatBorderedRows(split: SourceLines, style: BorderStyle): string | null {
  if (split.lines.length < 4) {
    return null;
  }
  const top = parseBorder(split.lines[0] ?? "", style.top);
  const middle = parseBorder(split.lines[2] ?? "", style.middle);
  const bottom = parseBorder(split.lines.at(-1) ?? "", style.bottom);
  if (top === null || !sameWidths(top, middle) || !sameWidths(top, bottom)) {
    return null;
  }
  const rows = [split.lines[1] ?? "", ...split.lines.slice(3, -1)].map((line) =>
    parseDelimitedRow(line, style.row),
  );
  if (rows.some((row) => row === null || row.length !== top.length)) {
    return null;
  }
  return renderRows(
    rows.filter((row): row is readonly string[] => row !== null),
    split.trailingNewline,
  );
}

function parseBorder(line: string, border: Border): readonly number[] | null {
  const [left, join, right, fill] = border;
  if (!line.startsWith(left) || !line.endsWith(right)) {
    return null;
  }
  const segments = line.slice(left.length, -right.length).split(join);
  return segments.length > 0 &&
    segments.every(
      (segment) => segment.length > 0 && [...segment].every((character) => character === fill),
    )
    ? segments.map((segment) => [...segment].length)
    : null;
}

function sameWidths(expected: readonly number[], actual: readonly number[] | null): boolean {
  return (
    actual !== null &&
    actual.length === expected.length &&
    actual.every((width, index) => width === expected[index])
  );
}

function parseDelimitedRow(line: string, delimiter: string): readonly string[] | null {
  if (!line.startsWith(delimiter) || !line.endsWith(delimiter)) {
    return null;
  }
  const cells = line.slice(delimiter.length, -delimiter.length).split(delimiter);
  return cells.length > 0 ? cells.map((cell) => cell.trim()) : null;
}

function parseMarkdownSeparator(line: string): number | null {
  const cells = parseDelimitedRow(line, "|");
  return cells?.every((cell) => /^:?-+:?$/u.test(cell)) ? cells.length : null;
}

function parseLineCell(line: string): LineCell | null {
  const delimiter = " = ";
  const delimiterIndex = line.indexOf(delimiter);
  if (delimiterIndex < 0 || line.indexOf(delimiter, delimiterIndex + delimiter.length) >= 0) {
    return null;
  }
  const key = line.slice(0, delimiterIndex).trim();
  if (key.length === 0) {
    return null;
  }
  return { key, value: line.slice(delimiterIndex + delimiter.length) };
}
