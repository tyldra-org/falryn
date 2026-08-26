/** Complete, uncapped container table and inspection projections. */

import { shortestText } from "../../text-format.ts";
import { formatAlignedTable } from "../table/format.ts";
import { containerLines, containerSubcommand, hasCallerPresentation } from "./shared.ts";

const HEADER_ALIASES: Readonly<Record<string, string>> = {
  "IMAGE ID": "ID",
  REPOSITORY: "REPO",
  CREATED: "AGE",
};

export function formatContainerTableOutput(
  text: string,
  commandTokens: readonly string[],
): string | null {
  if (hasCallerPresentation(commandTokens)) return null;
  const subcommand = containerSubcommand(commandTokens);
  if (subcommand === "inspect") return compactJson(text);
  if (subcommand !== "ps" && subcommand !== "images") return null;

  const lines = containerLines(text);
  if (lines.length === 1 && isContainerHeader(lines[0] ?? "", subcommand)) return "none";
  const formatted = formatAlignedTable(text);
  if (formatted === null) return null;
  const trailingNewline = formatted.endsWith("\n");
  const rows = formatted.split("\n");
  if (trailingNewline) rows.pop();
  const header = rows[0]?.split("\t");
  if (header === undefined) return null;
  rows[0] = header.map((cell) => HEADER_ALIASES[cell] ?? cell).join("\t");
  const result = rows.join("\n");
  return shortestText(text, trailingNewline ? `${result}\n` : result);
}

function compactJson(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object") return null;
    const compact = JSON.stringify(value);
    return compact === undefined ? null : shortestText(text, compact);
  } catch {
    return null;
  }
}

function isContainerHeader(header: string, subcommand: string): boolean {
  if (subcommand === "images") return /\b(?:IMAGE\s+ID|ID)\b/u.test(header);
  return /\b(?:CONTAINER\s+ID|ID|NAME)\b/u.test(header);
}
