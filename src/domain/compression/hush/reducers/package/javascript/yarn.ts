/** Yarn output reduction. */

import { compactDuplicateRuns, shortestText, stripAnsi } from "../../shared/text.ts";
import { firstNonblankLine, formatDependencyTree, trimOuterBlankLines } from "./shared.ts";

export function formatYarnInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  if (!lines.some((line) => /^Done in \S+\.?$/u.test(line.trim()))) return null;
  const result: string[] = [];
  let changed = false;
  for (const source of lines) {
    const line = source.trim();
    if (
      line.length === 0 ||
      /^yarn (?:add|install|remove|up|upgrade) v\S+$/u.test(line) ||
      /^\[\d+\/\d+\]\s+.+\.\.\.$/u.test(line) ||
      /^Done in \S+\.?$/u.test(line)
    ) {
      changed = true;
      continue;
    }
    if (line === "success Saved lockfile.") {
      result.push("lockfile saved");
      changed = true;
      continue;
    }
    const saved = /^success Saved (\d+) new dependencies\.$/u.exec(line);
    if (saved !== null) {
      result.push(`dependencies +${saved[1]}`);
      changed = true;
      continue;
    }
    if (line === "info Direct dependencies") {
      result.push("direct:");
      changed = true;
      continue;
    }
    if (line === "info All dependencies") {
      result.push("all:");
      changed = true;
      continue;
    }
    const dependency = /^(?:├─|└─)\s*(.+)$/u.exec(line);
    if (dependency !== null) {
      result.push(dependency[1] ?? "");
      changed = true;
      continue;
    }
    result.push(line);
  }
  return changed ? shortestText(plain, result.join("\n")) : null;
}

export function formatYarnList(plain: string): string | null {
  return formatDependencyTree(plain, true);
}

export function formatYarnScript(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const banner = firstNonblankLine(lines);
  let changed = false;
  if (/^yarn run v\S+$/u.test(lines[banner] ?? "")) {
    lines.splice(banner, 1);
    changed = true;
    const command = firstNonblankLine(lines, banner);
    if (/^\$\s+\S/u.test(lines[command] ?? "")) {
      lines[command] = (lines[command] ?? "").replace(/^\$\s+/u, "");
    }
    const done = lines.findIndex((line) => /^Done in \S+\.?$/u.test(line));
    if (done >= 0) lines.splice(done, 1);
  }
  trimOuterBlankLines(lines);
  const formatted = compactDuplicateRuns(lines.join("\n"));
  return !changed && formatted === plain ? null : shortestText(plain, formatted);
}
