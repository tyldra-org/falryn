/** Complete status projections for small infrastructure CLIs. */

import { shortestText } from "../../text-format.ts";
import { buildLines } from "../build/shared.ts";

export function formatFail2banStatus(text: string): string | null {
  const lines = buildLines(text);
  if (lines[0] !== "Status") return null;
  const values: string[] = [];
  for (const line of lines.slice(1)) {
    const entry = /^(?:\|-|`-)\s*(.+?):\s*(.+)$/u.exec(line.trimStart());
    if (entry === null) return null;
    values.push(`${normalizeKey(entry[1] ?? "")}=${(entry[2] ?? "").replace(/,\s+/gu, ",")}`);
  }
  return values.length === 0 ? null : shortestText(text, values.join(" "));
}

export function formatLiquibaseStatus(text: string): string | null {
  const lines = buildLines(text);
  const heading = /^(\d+) changesets? have not been applied to (.+)$/u.exec(lines[0] ?? "");
  const terminal = /^Liquibase command 'status' was executed successfully\.$/u;
  if (heading === null || !terminal.test(lines.at(-1) ?? "")) return null;
  const changesets = lines.slice(1, -1).map((line) => line.trim());
  if (changesets.length !== Number(heading[1])) return null;
  const formatted = [`pending=${heading[1]} target=${heading[2]}`, ...changesets, "ok"].join("\n");
  return shortestText(text, formatted);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "-");
}
