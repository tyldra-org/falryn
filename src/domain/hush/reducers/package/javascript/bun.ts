/** Bun package and script output reduction. */

import { compactDuplicateRuns, shortestText, stripAnsi } from "../../shared/text.ts";
import { firstNonblankLine, trimOuterBlankLines } from "./shared.ts";

export function formatBunInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const bannerIndex = firstNonblankLine(lines);
  const banner = /^bun (install|add|remove|update) v(\S+) \(([^)]+)\)$/u.exec(
    lines[bannerIndex]?.trim() ?? "",
  );
  const complete = lines.some((line) => /^\d+ packages? installed \[[^\]]+\]$/u.test(line.trim()));
  if (banner === null || !complete) return null;
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (index === bannerIndex) {
      result.push(`bun ${banner[1]} v${banner[2]} (${banner[3]})`);
      continue;
    }
    if (line.length === 0 || line === "Resolving dependencies") continue;
    const resolution = /^Resolved, downloaded and extracted \[(\d+)\]$/u.exec(line);
    if (resolution !== null) {
      result.push(`resolved/downloaded/extracted ${resolution[1]}`);
      continue;
    }
    if (line === "Saved lockfile") {
      result.push("lockfile saved");
      continue;
    }
    const installed = /^(\d+) packages? installed \[([^\]]+)\]$/u.exec(line);
    if (installed !== null) {
      result.push(`installed ${installed[1]} packages [${installed[2]}]`);
      continue;
    }
    result.push(line);
  }
  return shortestText(plain, result.join("\n"));
}

export function formatBunScript(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const banner = firstNonblankLine(lines);
  let changed = false;
  if (/^\$\s+\S/u.test(lines[banner] ?? "")) {
    lines[banner] = (lines[banner] ?? "").replace(/^\$\s+/u, "");
    changed = true;
  }
  trimOuterBlankLines(lines);
  const formatted = compactDuplicateRuns(lines.join("\n"));
  return !changed && formatted === plain ? null : shortestText(plain, formatted);
}
