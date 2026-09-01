/** Cargo and nextest output reduction. */

import { countSummary, drop, keep, projectTestLines, replace } from "../shared.ts";

export function formatRustTests(text: string, nextest: boolean): string | null {
  return nextest ? formatNextest(text) : formatCargo(text);
}

function formatCargo(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^\s*(?:Compiling|Finished|Running|Doc-tests)\b/u.test(line) ||
      /^running \d+ tests?$/u.test(line)
    ) {
      return drop();
    }
    if (/^test .+ \.\.\. ok$/u.test(line)) return drop();
    const summary =
      /^test result:\s+(?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out(?:;\s+finished in ([\d.]+s))?$/u.exec(
        line,
      );
    if (summary === null) return keep();
    const parts = [countSummary(summary[1] ?? "0", summary[2], undefined, summary[6])];
    if (summary[3] !== "0") parts.push(`${summary[3]} ignored`);
    if (summary[4] !== "0") parts.push(`${summary[4]} measured`);
    if (summary[5] !== "0") parts.push(`${summary[5]} filtered`);
    return replace(parts.join(" "));
  });
}

function formatNextest(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (/^\s*(?:Starting|PASS)\b/u.test(line)) return drop();
    const summary =
      /^\s*Summary\s+\[([^\]]+)\]\s+(\d+) tests? run:\s+(\d+) passed(?:,\s+(\d+) failed)?(?:,\s+(\d+) skipped)?$/u.exec(
        line,
      );
    return summary === null
      ? keep()
      : replace(countSummary(summary[3] ?? "0", summary[4], summary[5], summary[1]));
  });
}
