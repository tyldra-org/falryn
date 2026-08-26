/** Lossless changed-line projection for a complete external unified diff. */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/u;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

type HunkCounts = Readonly<{
  oldLines: number;
  newLines: number;
}>;

export function formatExternalUnifiedDiff(source: string): string | null {
  const lines = source.split("\n");
  const trailingNewline = source.endsWith("\n");
  if (trailingNewline) {
    lines.pop();
  }

  const formatted: string[] = [];
  let index = 0;
  let fileCount = 0;
  while (index < lines.length) {
    const before = unifiedPath(lines[index], "--- ");
    const after = unifiedPath(lines[index + 1], "+++ ");
    if (before === null || after === null) {
      return null;
    }
    if (fileCount > 0) {
      formatted.push("");
    }
    formatted.push(`${before} -> ${after}`);
    index += 2;

    let hunkCount = 0;
    while (index < lines.length && !startsFile(lines, index)) {
      const header = lines[index] ?? "";
      const counts = hunkCounts(header);
      if (counts === null) {
        return null;
      }
      formatted.push(header);
      index += 1;
      hunkCount += 1;

      let oldLines = 0;
      let newLines = 0;
      let changedLines = 0;
      while (index < lines.length && !startsFile(lines, index) && !isHunkHeader(lines[index])) {
        const line = lines[index] ?? "";
        if (line.startsWith(" ")) {
          oldLines += 1;
          newLines += 1;
        } else if (line.startsWith("-")) {
          oldLines += 1;
          changedLines += 1;
          formatted.push(line);
        } else if (line.startsWith("+")) {
          newLines += 1;
          changedLines += 1;
          formatted.push(line);
        } else if (line === NO_NEWLINE_MARKER) {
          formatted.push(line);
        } else {
          return null;
        }
        index += 1;
      }
      if (changedLines === 0 || oldLines !== counts.oldLines || newLines !== counts.newLines) {
        return null;
      }
    }
    if (hunkCount === 0) {
      return null;
    }
    fileCount += 1;
  }

  if (fileCount === 0) {
    return null;
  }
  const result = formatted.join("\n");
  return trailingNewline ? `${result}\n` : result;
}

function startsFile(lines: readonly string[], index: number): boolean {
  return (
    unifiedPath(lines[index], "--- ") !== null && unifiedPath(lines[index + 1], "+++ ") !== null
  );
}

function unifiedPath(line: string | undefined, prefix: "--- " | "+++ "): string | null {
  if (line === undefined || !line.startsWith(prefix)) {
    return null;
  }
  const value = line.slice(prefix.length);
  const separator = value.lastIndexOf("\t");
  if (separator < 0 || !TIMESTAMP.test(value.slice(separator + 1))) {
    return value.length === 0 ? null : value;
  }
  const path = value.slice(0, separator);
  return path.length === 0 ? null : path;
}

function hunkCounts(line: string): HunkCounts | null {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    return null;
  }
  return {
    oldLines: countFrom(match[2]),
    newLines: countFrom(match[4]),
  };
}

function countFrom(value: string | undefined): number {
  return value === undefined ? 1 : Number.parseInt(value, 10);
}

function isHunkHeader(line: string | undefined): boolean {
  return line !== undefined && HUNK_HEADER.test(line);
}
