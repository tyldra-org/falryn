/** Lossless, model-readable text compaction shared by Hush projections. */

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

export function compactJsonWhitespace(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return null;
  }

  let inString = false;
  let escaped = false;
  let compact = "";
  for (const character of trimmed) {
    if (inString) {
      compact += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      compact += character;
    } else if (!/\s/u.test(character)) {
      compact += character;
    }
  }

  try {
    JSON.parse(compact);
    return compact;
  } catch {
    return null;
  }
}

export function compactDuplicateRuns(
  text: string,
  keepExact: (line: string) => boolean = () => false,
): string {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }

  const compacted: string[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    let end = index + 1;
    while (end < lines.length && lines[end] === line) {
      end += 1;
    }
    const count = end - index;
    const run = Array.from({ length: count }, () => line).join("\n");
    const summary = `${line} ×${count}`;
    compacted.push(
      count > 1 && line.length > 0 && !keepExact(line) && summary.length < run.length
        ? summary
        : run,
    );
    index = end;
  }

  const result = compacted.join("\n");
  return trailingNewline ? `${result}\n` : result;
}

export function shortestText(...candidates: readonly string[]): string {
  let shortest = candidates[0] ?? "";
  for (const candidate of candidates.slice(1)) {
    if (encodedBytes(candidate) < encodedBytes(shortest)) {
      shortest = candidate;
    }
  }
  return shortest;
}

export function encodedBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
