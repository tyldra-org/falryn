/** Complete compaction for one validated PostgreSQL `psql` result. */

export function formatPsqlResult(source: string): string | null {
  return formatPsqlAlignedTable(source) ?? formatPsqlExpandedTable(source);
}

export function formatPsqlAlignedTable(source: string): string | null {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  if (lines.length < 3) {
    return null;
  }

  const footer = parseRowFooter(lines.at(-1) ?? "");
  const columns = parseSeparator(lines[1] ?? "");
  if (footer === null || columns === null) {
    return null;
  }

  const dataLines = lines.slice(2, -1);
  if (dataLines.length !== footer) {
    return null;
  }

  const header = parseRow(lines[0] ?? "", columns);
  if (header === null) {
    return null;
  }
  const rows = dataLines.map((line) => parseRow(line, columns));
  if (rows.some((row) => row === null)) {
    return null;
  }

  const completeRows = rows.filter((row): row is readonly string[] => row !== null);
  const result = [header, ...completeRows].map((row) => row.join("\t")).join("\n");
  return trailingNewline ? `${result}\n` : result;
}

export function formatPsqlExpandedTable(source: string): string | null {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  if (lines.length < 3) {
    return null;
  }

  const footer = parseRowFooter(lines.at(-1) ?? "");
  if (footer === null || footer === 0) {
    return null;
  }

  const records: ExpandedRecord[] = [];
  let index = 0;
  while (index < lines.length - 1) {
    const recordNumber = parseRecordHeader(lines[index] ?? "");
    if (recordNumber === null || recordNumber !== records.length + 1) {
      return null;
    }
    index += 1;

    const cells: ExpandedCell[] = [];
    const keys = new Set<string>();
    while (index < lines.length - 1 && parseRecordHeader(lines[index] ?? "") === null) {
      const cell = parseExpandedCell(lines[index] ?? "");
      if (cell === null || keys.has(cell.key)) {
        return null;
      }
      cells.push(cell);
      keys.add(cell.key);
      index += 1;
    }
    if (cells.length === 0) {
      return null;
    }
    records.push({ number: recordNumber, cells });
  }

  if (records.length !== footer) {
    return null;
  }
  const header = records[0]?.cells.map((cell) => cell.key) ?? [];
  if (
    header.length === 0 ||
    records.some(
      (record) =>
        record.cells.length !== header.length ||
        record.cells.some((cell, cellIndex) => cell.key !== header[cellIndex]),
    )
  ) {
    return null;
  }

  const result = [
    ["record", ...header],
    ...records.map((record) => [String(record.number), ...record.cells.map((cell) => cell.value)]),
  ]
    .map((row) => row.join("\t"))
    .join("\n");
  return trailingNewline ? `${result}\n` : result;
}

type ExpandedCell = Readonly<{ key: string; value: string }>;
type ExpandedRecord = Readonly<{ number: number; cells: readonly ExpandedCell[] }>;

function parseRowFooter(line: string): number | null {
  const match = /^\((\d+) (row|rows)\)$/u.exec(line);
  if (match === null) {
    return null;
  }
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count)) {
    return null;
  }
  const label = match[2];
  return (count === 1 && label === "row") || (count !== 1 && label === "rows") ? count : null;
}

function parseSeparator(line: string): number | null {
  if (line.includes("\t") || line.includes("\r")) {
    return null;
  }
  const segments = line.split("+");
  return segments.length > 0 && segments.every((segment) => /^-+$/u.test(segment))
    ? segments.length
    : null;
}

function parseRecordHeader(line: string): number | null {
  const match = /^-\[ RECORD (\d+) \]-+$/u.exec(line);
  if (match === null) {
    return null;
  }
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

function parseExpandedCell(line: string): ExpandedCell | null {
  if (line.includes("\t") || line.includes("\r")) {
    return null;
  }
  const delimiter = " | ";
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

function parseRow(line: string, columns: number): readonly string[] | null {
  if (line.includes("\t") || line.includes("\r")) {
    return null;
  }
  const cells = line.split(" | ");
  if (cells.length !== columns) {
    return null;
  }
  return cells.map((cell) => cell.trim());
}
