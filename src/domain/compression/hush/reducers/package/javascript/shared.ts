/** Shared package-manager formatting primitives. */

import { shortestText } from "../../shared/text.ts";

export type PackageGroup = "prod" | "dev" | "optional" | "peer";

export const SECTION_NAMES: Readonly<Record<string, PackageGroup>> = {
  "dependencies:": "prod",
  "devdependencies:": "dev",
  "optionaldependencies:": "optional",
  "peerdependencies:": "peer",
};

export function formatDependencyTree(plain: string, yarn: boolean): string | null {
  const lines = plain.split("\n");
  let changed = false;
  const formatted: string[] = [];
  for (const source of lines) {
    const line = source.trimEnd();
    if (yarn && (/^yarn list v\S+$/u.test(line) || /^Done in \S+\.?$/u.test(line))) {
      changed = true;
      continue;
    }
    if (line.length === 0) {
      changed = true;
      continue;
    }
    const tree = line
      .replaceAll("│   ", "  ")
      .replaceAll("│  ", "  ")
      .replace(/(?:├──|└──|├─|└─)\s*/gu, "- ");
    changed ||= tree !== line;
    formatted.push(tree);
  }
  return changed && formatted.some((line) => /^\s*-\s/u.test(line))
    ? shortestText(plain, formatted.join("\n"))
    : null;
}

export function packageGroups(): Record<PackageGroup, string[]> {
  return { prod: [], dev: [], optional: [], peer: [] };
}

export function packageGroupLines(
  groups: Readonly<Record<PackageGroup, readonly string[]>>,
): string[] {
  return (Object.entries(groups) as [PackageGroup, readonly string[]][])
    .filter(([, dependencies]) => dependencies.length > 0)
    .map(([group, dependencies]) => `${group}: ${dependencies.join(", ")}`);
}

export function installPackageGroupLines(
  groups: Readonly<Record<PackageGroup, readonly string[]>>,
): string[] {
  return (Object.entries(groups) as [PackageGroup, readonly string[]][])
    .filter(([, dependencies]) => dependencies.length > 0)
    .map(
      ([group, dependencies]) =>
        `${group} ${dependencies.map((dependency) => dependency.replace(/^\+/u, "")).join(", ")}`,
    );
}

export function trimOuterBlankLines(lines: string[]): void {
  while (lines[0]?.trim().length === 0) lines.shift();
  while (lines.at(-1)?.trim().length === 0) lines.pop();
}

export function firstNonblankLine(lines: readonly string[], start = 0): number {
  const index = lines.findIndex((line, lineIndex) => lineIndex >= start && line.trim().length > 0);
  return index < 0 ? lines.length : index;
}
