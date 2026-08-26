/** Complete table projections for infrastructure CLIs. */

import { shortestText } from "../../text-format.ts";
import { buildLines } from "../build/shared.ts";
import { formatAlignedTable } from "../table/format.ts";

export function formatInfrastructureTable(text: string): string | null {
  return formatAlignedTable(text);
}

export function formatIptablesListing(text: string): string | null {
  const lines = buildLines(text);
  if (lines.length < 2 || !lines.some((line) => /^Chain \S+ \(.+\)$/u.test(line))) return null;
  const output: string[] = [];
  for (const line of lines) {
    if (/^Chain \S+ \(.+\)$/u.test(line)) {
      output.push(line);
      continue;
    }
    if (!/^(?:pkts\s+bytes\s+target|\d+\s+\d+\s+)/u.test(line.trimStart())) return null;
    output.push(line.trim().replace(/\s{2,}/gu, "\t"));
  }
  return shortestText(text, output.join("\n"));
}
