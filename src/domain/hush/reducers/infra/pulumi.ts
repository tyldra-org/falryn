/** Complete Pulumi projections with all resource and output facts retained. */

import { buildLines } from "../build/shared.ts";
import { shortestText } from "../shared/text.ts";
import { formatInfrastructureTable } from "./tables.ts";

export function formatPulumi(text: string, commandTokens: readonly string[]): string | null {
  if (commandTokens[1] === "stack" && commandTokens[2] === "ls") {
    return formatInfrastructureTable(text);
  }
  if (!["preview", "up", "destroy", "refresh"].includes(commandTokens[1] ?? "")) return null;
  const output: string[] = [];
  let sawSummary = false;
  for (const line of buildLines(text)) {
    const action = /^(Previewing update|Updating|Destroying|Refreshing) \(([^)]+)\)$/u.exec(line);
    if (action !== null) {
      output.push(`${commandTokens[1]} ${action[2]}`);
      continue;
    }
    const url = /^View (?:in Browser|Live):\s+(.+)$/u.exec(line);
    if (url !== null) {
      output.push(`url ${url[1]}`);
      continue;
    }
    if (/^@\s+(?:previewing update|updating|destroying|refreshing)\.\.\.$/u.test(line)) continue;
    if (line === "Resources:" || line === "Outputs:") {
      output.push(line.toLowerCase().replace(":", ""));
      continue;
    }
    const summary =
      /^([+~-])\s+(\d+)\s+(to create|to update|to delete|created|updated|deleted|unchanged)$/u.exec(
        line.trim(),
      );
    if (summary !== null) {
      output.push(`${summary[1]}${summary[2]} ${summary[3]}`);
      sawSummary = true;
      continue;
    }
    const duration = /^Duration:\s+(.+)$/u.exec(line);
    if (duration !== null) {
      output.push(`duration=${duration[1]}`);
      continue;
    }
    output.push(line.trim().replace(/\s{2,}/gu, " "));
  }
  if (output.length === 0 || !sawSummary) return null;
  return shortestText(text, output.join("\n"));
}
