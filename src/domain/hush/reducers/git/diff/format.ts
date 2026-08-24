/** Complete Git unified-diff projection with validated duplicate headers removed. */

import { type GitDiffPaths, pathsFromDiffGit } from "../paths.ts";

const DIFF_HEADER = "diff --git ";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u;
const INDEX_LINE = /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d{6})?$/u;
const MODE_LINE = /^(?:old mode|new mode|new file mode|deleted file mode) \d{6}$/u;
const SIMILARITY_LINE = /^(?:similarity|dissimilarity) index (?:100|[1-9]?\d)%$/u;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

type HunkCounts = Readonly<{ oldLines: number; newLines: number }>;

export function formatGitUnifiedDiff(source: string): string | null {
  if (source.length === 0 || source.includes("\r") || source.includes("\0")) {
    return null;
  }
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }

  const formatted: string[] = [];
  let index = 0;
  let files = 0;
  while (index < lines.length) {
    const header = lines[index] ?? "";
    if (!header.startsWith(DIFF_HEADER)) {
      return null;
    }
    const paths = pathsFromDiffGit(header.slice(DIFF_HEADER.length));
    if (paths === null) {
      return null;
    }
    const sectionEnd = nextFileIndex(lines, index + 1);
    const section = formatFileSection(lines.slice(index + 1, sectionEnd), paths);
    if (section === null) {
      return null;
    }
    if (files > 0) {
      formatted.push("");
    }
    const path = paths.before === paths.after ? paths.before : `${paths.before} → ${paths.after}`;
    formatted.push(`${path}:`, ...section);
    files += 1;
    index = sectionEnd;
  }

  if (files === 0) {
    return null;
  }
  const result = formatted.join("\n");
  return trailingNewline ? `${result}\n` : result;
}

function formatFileSection(
  lines: readonly string[],
  paths: GitDiffPaths,
): readonly string[] | null {
  if (lines.length === 0) {
    return null;
  }
  const metadata: string[] = [];
  let index = 0;
  while (index < lines.length && !isPatchHeader(lines[index]) && !isHunkHeader(lines[index])) {
    const line = lines[index] ?? "";
    if (!isMetadataLine(line, paths)) {
      return null;
    }
    metadata.push(line);
    index += 1;
  }

  const hasNewFile = metadata.some((line) => line.startsWith("new file mode "));
  const hasDeletedFile = metadata.some((line) => line.startsWith("deleted file mode "));
  if (hasNewFile && hasDeletedFile) {
    return null;
  }

  const hasPatchHeaders = isPatchHeader(lines[index]);
  if (hasPatchHeaders) {
    const before = patchPath(lines[index], "--- ");
    const after = patchPath(lines[index + 1], "+++ ");
    const expectedBefore = hasNewFile ? "/dev/null" : paths.beforeHeader;
    const expectedAfter = hasDeletedFile ? "/dev/null" : paths.afterHeader;
    if (before !== expectedBefore || after !== expectedAfter) {
      return null;
    }
    index += 2;
  }

  const body: string[] = [];
  let hunks = 0;
  while (index < lines.length) {
    const header = lines[index] ?? "";
    const counts = hunkCounts(header);
    if (counts === null) {
      return null;
    }
    body.push(header);
    index += 1;
    hunks += 1;

    let oldLines = 0;
    let newLines = 0;
    let changedLines = 0;
    let previousWasChange = false;
    while (index < lines.length && !isHunkHeader(lines[index])) {
      const line = lines[index] ?? "";
      if (line.startsWith(" ")) {
        oldLines += 1;
        newLines += 1;
        previousWasChange = false;
      } else if (line.startsWith("-")) {
        oldLines += 1;
        changedLines += 1;
        previousWasChange = true;
      } else if (line.startsWith("+")) {
        newLines += 1;
        changedLines += 1;
        previousWasChange = true;
      } else if (line === NO_NEWLINE_MARKER && previousWasChange) {
        previousWasChange = false;
      } else {
        return null;
      }
      body.push(line);
      index += 1;
    }
    if (changedLines === 0 || oldLines !== counts.oldLines || newLines !== counts.newLines) {
      return null;
    }
  }

  if (hunks === 0) {
    return !hasPatchHeaders && hasSemanticMetadata(metadata)
      ? metadata.map(formatMetadataLine)
      : null;
  }
  return hasPatchHeaders ? [...metadata.map(formatMetadataLine), ...body] : null;
}

function formatMetadataLine(line: string): string {
  if (INDEX_LINE.test(line)) {
    return line.slice("index ".length);
  }
  if (line.startsWith("new file mode ")) {
    return `new ${line.slice("new file mode ".length)}`;
  }
  if (line.startsWith("deleted file mode ")) {
    return `deleted ${line.slice("deleted file mode ".length)}`;
  }
  return line;
}

function isMetadataLine(line: string, paths: GitDiffPaths): boolean {
  if (INDEX_LINE.test(line) || MODE_LINE.test(line) || SIMILARITY_LINE.test(line)) {
    return true;
  }
  return (
    line === `rename from ${paths.before}` ||
    line === `rename to ${paths.after}` ||
    line === `copy from ${paths.before}` ||
    line === `copy to ${paths.after}`
  );
}

function hasSemanticMetadata(lines: readonly string[]): boolean {
  return lines.some((line) => !INDEX_LINE.test(line));
}

function isPatchHeader(line: string | undefined): boolean {
  return line?.startsWith("--- ") ?? false;
}

function patchPath(line: string | undefined, prefix: "--- " | "+++ "): string | null {
  if (line === undefined || !line.startsWith(prefix)) {
    return null;
  }
  const value = line.slice(prefix.length);
  return value.length > 0 && !value.includes("\t") ? value : null;
}

function hunkCounts(line: string): HunkCounts | null {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    return null;
  }
  const oldLines = countFrom(match[2]);
  const newLines = countFrom(match[4]);
  return oldLines === null || newLines === null ? null : { oldLines, newLines };
}

function countFrom(value: string | undefined): number | null {
  const count = value === undefined ? 1 : Number.parseInt(value, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function isHunkHeader(line: string | undefined): boolean {
  return line !== undefined && HUNK_HEADER.test(line);
}

function nextFileIndex(lines: readonly string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index]?.startsWith(DIFF_HEADER)) {
      return index;
    }
  }
  return lines.length;
}
