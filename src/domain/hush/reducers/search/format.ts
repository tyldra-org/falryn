import { encodedBytes } from "../../text-format.ts";

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

  const matches = lines.map(parseSearchMatch);
  if (matches.some((match) => match === null)) {
    return null;
  }

  const formatted: string[] = [];
  let currentPath: string | null = null;
  for (const match of matches) {
    if (match === null) {
      return null;
    }
    if (match.path !== currentPath) {
      formatted.push(`${match.path}:`);
      currentPath = match.path;
    }
    const location = match.column === null ? match.line : `${match.line}:${match.column}`;
    formatted.push(`  ${location} ${match.content}`);
  }

  const result = `${formatted.join("\n")}${trailingNewline ? "\n" : ""}`;
  return encodedBytes(result) < encodedBytes(text) ? result : null;
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
