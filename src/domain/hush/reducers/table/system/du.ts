import { renderRows, splitSource } from "./shared.ts";

export function formatDuResult(source: string): string | null {
  const split = splitSource(source);
  if (split.lines.length === 0 || source.includes("\r")) {
    return null;
  }
  const rows = split.lines.map(parseDuRow);
  if (rows.some((row) => row === null)) {
    return null;
  }
  return renderRows(
    rows.filter((row): row is readonly string[] => row !== null),
    split.trailingNewline,
  );
}

function parseDuRow(line: string): readonly string[] | null {
  const tab = line.indexOf("\t");
  if (tab >= 0) {
    return line.indexOf("\t", tab + 1) < 0 && tab > 0 && tab < line.length - 1
      ? [line.slice(0, tab), line.slice(tab + 1)]
      : null;
  }
  const match = /^(\S+) {2,}(.+)$/u.exec(line);
  return match === null ? null : [match[1] ?? "", match[2] ?? ""];
}
