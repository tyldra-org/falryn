/** Complete rsync transfer projection with every reported path and counter. */

import { shortestText } from "../../text-format.ts";
import { buildLines } from "../build/shared.ts";

export function formatRsyncOutput(text: string): string | null {
  const lines = buildLines(text);
  const output: string[] = [];
  let sawProgressHeader = false;
  let sawTransferSummary = false;
  let sawTotalSummary = false;

  for (const line of lines) {
    if (/^(?:sending incremental file list|building file list \.\.\. done)$/u.test(line)) {
      continue;
    }

    const progress = parseProgress(line);
    if (progress !== null) {
      const previous = output.pop();
      if (previous === undefined) return null;
      if (!sawProgressHeader) {
        output.push("path\tbytes\t%\trate\telapsed\txfr\tremaining");
        sawProgressHeader = true;
      }
      output.push(`${previous}\t${progress}`);
      continue;
    }

    const transfer = /^sent ([\d,]+) bytes\s+received ([\d,]+) bytes\s+([\d,.]+) bytes\/sec$/u.exec(
      line,
    );
    if (transfer !== null) {
      output.push(
        `sent=${transfer[1]?.replaceAll(",", "")}B received=${transfer[2]?.replaceAll(",", "")}B rate=${transfer[3]?.replaceAll(",", "")}B/s`,
      );
      sawTransferSummary = true;
      continue;
    }

    const total = /^total size is ([\d,]+)\s+speedup is ([\d.]+)$/u.exec(line);
    if (total !== null) {
      output.push(`total=${total[1]?.replaceAll(",", "")}B speedup=${total[2]}`);
      sawTotalSummary = true;
      continue;
    }

    const created = /^created directory (.+)$/u.exec(line);
    if (created !== null) {
      output.push(`created-dir ${created[1]}`);
      continue;
    }
    const deleted = /^deleting (.+)$/u.exec(line);
    if (deleted !== null) {
      output.push(`delete ${deleted[1]}`);
      continue;
    }
    output.push(line.trim());
  }

  return sawTransferSummary && sawTotalSummary ? shortestText(text, output.join("\n")) : null;
}

function parseProgress(line: string): string | null {
  const match =
    /^\s*([\d,]+)\s+(\d+)%\s+([\d.]+[KMGT]?B\/s)\s+(\d+:\d+:\d+)\s+\((?:xfr|xfer)#(\d+),\s*(?:to-chk|to-check|ir-chk)=(\d+)\/(\d+)\)$/u.exec(
      line,
    );
  if (match === null) return null;
  return `${match[1]?.replaceAll(",", "")}\t${match[2]}\t${match[3]}\t${match[4]}\t${match[5]}\t${match[6]}/${match[7]}`;
}
