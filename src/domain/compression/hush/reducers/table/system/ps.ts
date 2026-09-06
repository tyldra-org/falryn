import { renderRows, splitSource } from "./shared.ts";

const ATOMIC_COLUMNS = new Set([
  "%CPU",
  "%MEM",
  "C",
  "CPU",
  "ELAPSED",
  "ETIME",
  "F",
  "FLAGS",
  "GID",
  "GROUP",
  "NI",
  "PCPU",
  "PGID",
  "PID",
  "PMEM",
  "PPID",
  "PRI",
  "RSS",
  "RUID",
  "RUSER",
  "SID",
  "START",
  "STAT",
  "STATE",
  "TIME",
  "TPGID",
  "TT",
  "TTY",
  "UID",
  "USER",
  "VSZ",
  "WCHAN",
]);

const STANDARD_PS_HEADERS = [
  ["USER", "PID", "%CPU", "%MEM", "VSZ", "RSS", "TT", "STAT", "STARTED", "TIME", "COMMAND"],
  ["USER", "PID", "%CPU", "%MEM", "VSZ", "RSS", "TTY", "STAT", "START", "TIME", "COMMAND"],
] as const;

export function formatPsResult(source: string): string | null {
  const split = splitSource(source);
  if (split.lines.length < 2 || source.includes("\t") || source.includes("\r")) {
    return null;
  }
  const header = split.lines[0]?.trim().split(/\s+/u) ?? [];
  if (
    header.length < 2 ||
    (!STANDARD_PS_HEADERS.some((candidate) => equalCells(candidate, header)) &&
      header.slice(0, -1).some((column) => !ATOMIC_COLUMNS.has(column.toUpperCase())))
  ) {
    return null;
  }
  const rows = split.lines.slice(1).map((line) => parsePsRow(line, header.length));
  if (rows.some((row) => row === null)) {
    return null;
  }
  return renderRows(
    [header, ...rows.filter((row): row is readonly string[] => row !== null)],
    split.trailingNewline,
  );
}

function equalCells(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((cell, index) => cell === right[index]);
}

function parsePsRow(line: string, columns: number): readonly string[] | null {
  let rest = line.trim();
  const cells: string[] = [];
  for (let index = 1; index < columns; index += 1) {
    const match = /^(\S+)\s+(.+)$/u.exec(rest);
    if (match === null) {
      return null;
    }
    cells.push(match[1] ?? "");
    rest = match[2] ?? "";
  }
  cells.push(rest);
  return cells.every((cell) => cell.length > 0) ? cells : null;
}
