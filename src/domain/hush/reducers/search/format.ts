import { encodedBytes } from "../shared/text.ts";

type SearchMatch = {
  readonly path: string;
  readonly line: string;
  readonly column: string | null;
  readonly content: string;
};

export function formatSearchMatches(text: string): string | null {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  if (lines.length === 0) {
    return text;
  }

  const formatted: string[] = [];
  for (let index = 0; index < lines.length; ) {
    if (parseSearchMatch(lines[index] ?? "") === null) {
      formatted.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < lines.length && parseSearchMatch(lines[end] ?? "") !== null) {
      end += 1;
    }
    const sourceBlock = lines.slice(index, end);
    const formattedBlock = formatSearchBlock(sourceBlock);
    formatted.push(
      ...(encodedBytes(formattedBlock.join("\n")) < encodedBytes(sourceBlock.join("\n"))
        ? formattedBlock
        : sourceBlock),
    );
    index = end;
  }

  const result = `${formatted.join("\n")}${trailingNewline ? "\n" : ""}`;
  return encodedBytes(result) < encodedBytes(text) ? result : null;
}

function formatSearchBlock(lines: readonly string[]): readonly string[] {
  const formatted: string[] = [];
  let currentPath: string | null = null;
  for (const line of lines) {
    const match = parseSearchMatch(line);
    if (match === null) {
      return lines;
    }
    if (match.path !== currentPath) {
      formatted.push(`${match.path}:`);
      currentPath = match.path;
    }
    const location = match.column === null ? match.line : `${match.line}:${match.column}`;
    formatted.push(`  ${location} ${match.content}`);
  }
  return formatted;
}

function parseSearchMatch(line: string): SearchMatch | null {
  const match = /^(.*?):(\d+)(?::(\d+))?:(.*)$/u.exec(line);
  const path = match?.[1];
  const lineNumber = match?.[2];
  const content = match?.[4];
  if (
    path === undefined ||
    path.length === 0 ||
    lineNumber === undefined ||
    content === undefined
  ) {
    return null;
  }
  return {
    path,
    line: lineNumber,
    column: match?.[3] ?? null,
    content,
  };
}
