/** pnpm output reduction. */

import { compactDuplicateRuns, shortestText, stripAnsi } from "../../shared/text.ts";
import {
  firstNonblankLine,
  installPackageGroupLines,
  packageGroupLines,
  packageGroups,
  SECTION_NAMES,
  trimOuterBlankLines,
} from "./shared.ts";

export function formatPnpmInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  if (!lines.some((line) => /^Done in \S+/u.test(line.trim()))) return null;
  const groups = packageGroups();
  const other: string[] = [];
  let section: keyof typeof groups | null = null;
  let packages: string | null = null;
  let changed = false;

  for (const source of lines) {
    const line = source.trim();
    if (line.length === 0 || /^Progress:/u.test(line) || /^[+-]{2,}$/u.test(line)) {
      changed = true;
      continue;
    }
    if (/^Done in \S+/u.test(line)) {
      changed = true;
      continue;
    }
    const total = /^Packages:\s*([+-]\d+)$/u.exec(line);
    if (total !== null) {
      packages = `${total[1]} packages`;
      changed = true;
      continue;
    }
    const heading = SECTION_NAMES[line.toLowerCase()];
    if (heading !== undefined) {
      section = heading;
      changed = true;
      continue;
    }
    if (section !== null && /^[+-]\s+\S/u.test(line)) {
      groups[section].push(line.replace(/^([+-])\s+/u, "$1"));
      changed = true;
      continue;
    }
    if (/^Lockfile is up to date, resolution step is skipped$/u.test(line)) {
      other.push("lockfile current; resolution skipped");
      changed = true;
      continue;
    }
    if (line === "Already up to date") {
      other.push("up to date");
      changed = true;
      continue;
    }
    section = null;
    other.push(line);
  }
  const result = [
    ...(packages === null ? [] : [packages]),
    ...installPackageGroupLines(groups),
    ...other,
  ].join("\n");
  return changed && result.length > 0 ? shortestText(plain, result) : null;
}

export function formatPnpmList(plain: string): string | null {
  const groups = packageGroups();
  const result: string[] = [];
  let section: keyof typeof groups | null = null;
  let changed = false;
  for (const source of plain.split("\n")) {
    const line = source.trim();
    if (line.length === 0 || line.startsWith("Legend:")) {
      changed = true;
      continue;
    }
    const heading = SECTION_NAMES[line.toLowerCase()];
    if (heading !== undefined) {
      section = heading;
      changed = true;
      continue;
    }
    if (section !== null) {
      const dependency = /^(\S+)\s+(\S+)$/u.exec(line);
      if (dependency === null) return null;
      groups[section].push(`${dependency[1]}@${dependency[2]}`);
      changed = true;
      continue;
    }
    if (result.length === 0 && /^\S+@\S+\s+\S+$/u.test(line)) {
      result.push(line);
      continue;
    }
    return null;
  }
  result.push(...packageGroupLines(groups));
  return changed && result.length > 0 ? shortestText(plain, result.join("\n")) : null;
}

export function formatPnpmScript(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const banner = firstNonblankLine(lines);
  let changed = false;
  if (/^>\s+\S+@\S+\s+\S+(?:\s+\S+)?$/u.test(lines[banner] ?? "")) {
    lines.splice(banner, 1);
    changed = true;
    const command = lines[banner];
    if (command !== undefined && /^>\s+\S/u.test(command)) {
      lines[banner] = command.replace(/^>\s+/u, "");
    }
  }
  trimOuterBlankLines(lines);
  const formatted = compactDuplicateRuns(lines.join("\n"));
  return !changed && formatted === plain ? null : shortestText(plain, formatted);
}
