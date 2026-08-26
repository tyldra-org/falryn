import { shortestText } from "../shared/text.ts";

const COMPACT_HEADERS: Readonly<Record<string, string>> = {
  "CONTAINER ID": "ID",
  NAMES: "NAME",
};

export function formatAlignedTable(text: string): string | null {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  if (lines.length < 2) {
    return null;
  }

  const rows = lines.map((line) => line.trim().split(/\s{2,}/u));
  const columns = rows[0]?.length ?? 0;
  if (columns < 2 || rows.some((row) => row.length !== columns)) {
    return null;
  }
  const normalized = rows.map((row, index) =>
    row.map((cell) => (index === 0 ? (COMPACT_HEADERS[cell] ?? cell) : cell)).join("\t"),
  );
  const formatted = `${normalized.join("\n")}${trailingNewline ? "\n" : ""}`;
  return shortestText(text, formatted);
}
