import { renderRows, splitSource } from "./shared.ts";

type DfSchema = Readonly<{ source: readonly string[]; target: readonly string[] }>;

const DF_SCHEMAS: readonly DfSchema[] = [
  {
    source: [
      "Filesystem",
      "Size",
      "Used",
      "Avail",
      "Capacity",
      "iused",
      "ifree",
      "%iused",
      "Mounted",
      "on",
    ],
    target: [
      "filesystem",
      "size",
      "used",
      "avail",
      "capacity",
      "iused",
      "ifree",
      "iused%",
      "mounted",
    ],
  },
  {
    source: ["Filesystem", "Size", "Used", "Avail", "Use%", "Mounted", "on"],
    target: ["filesystem", "size", "used", "avail", "use%", "mounted"],
  },
  {
    source: [
      "Filesystem",
      "512-blocks",
      "Used",
      "Available",
      "Capacity",
      "iused",
      "ifree",
      "%iused",
      "Mounted",
      "on",
    ],
    target: [
      "filesystem",
      "512-blocks",
      "used",
      "available",
      "capacity",
      "iused",
      "ifree",
      "iused%",
      "mounted",
    ],
  },
  {
    source: ["Filesystem", "1024-blocks", "Used", "Available", "Capacity", "Mounted", "on"],
    target: ["filesystem", "1024-blocks", "used", "available", "capacity", "mounted"],
  },
  {
    source: ["Filesystem", "1K-blocks", "Used", "Available", "Use%", "Mounted", "on"],
    target: ["filesystem", "1K-blocks", "used", "available", "use%", "mounted"],
  },
];

export function formatDfResult(source: string): string | null {
  const split = splitSource(source);
  if (split.lines.length < 2 || source.includes("\t") || source.includes("\r")) {
    return null;
  }
  const header = split.lines[0]?.trim().split(/\s+/u) ?? [];
  const schema = DF_SCHEMAS.find((candidate) => equalCells(candidate.source, header));
  if (schema === undefined) {
    return null;
  }
  const rows = split.lines.slice(1).map((line) => line.trim().split(/\s+/u));
  if (rows.some((row) => row.length !== schema.target.length)) {
    return null;
  }
  return renderRows([schema.target, ...rows], split.trailingNewline);
}

function equalCells(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((cell, index) => cell === right[index]);
}
