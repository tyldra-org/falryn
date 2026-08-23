/** Information-preserving normalization for the native textual tree format. */

import { isTreeNoiseName } from "./policy.ts";

type TreeEntry = Readonly<{
  depth: number;
  name: string;
}>;

const TREE_ENTRY = /^((?:(?:│ {3}|\| {3}| {4}))*)(?:├── |└── |\|-- |`-- |\\-- |\+-- )(.*)$/u;

export function compactTreeOutput(
  text: string,
  options: Readonly<{ pruneNoise: boolean }>,
): string {
  const output: string[] = [];
  let prunedDepth: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (isTreeSummary(line)) {
      continue;
    }
    const entry = parseTreeEntry(line);
    if (prunedDepth !== null) {
      if (entry !== null && entry.depth > prunedDepth) {
        continue;
      }
      prunedDepth = null;
    }
    if (entry !== null && options.pruneNoise && isTreeNoiseName(entry.name)) {
      prunedDepth = entry.depth;
      continue;
    }
    if (line.trim().length === 0 && output.length === 0) {
      continue;
    }
    output.push(line);
  }

  while (output.at(-1)?.trim().length === 0) {
    output.pop();
  }
  return `${output.join("\n")}\n`;
}

function isTreeSummary(line: string): boolean {
  return line.includes("director") && line.includes("file");
}

function parseTreeEntry(line: string): TreeEntry | null {
  const match = TREE_ENTRY.exec(line);
  const indent = match?.[1];
  const displayName = match?.[2];
  if (indent === undefined || displayName === undefined) {
    return null;
  }
  return {
    depth: indent.length / 4,
    name: treeEntryName(displayName),
  };
}

function treeEntryName(displayName: string): string {
  let name = stripAnsi(displayName).trim();
  while (name.startsWith("[")) {
    const metadata = /^\[[^\]]*\]\s*/.exec(name);
    if (metadata === null) {
      break;
    }
    name = name.slice(metadata[0].length);
  }
  name = (name.split(" -> ", 1)[0] ?? name).trim();
  if (
    name.length >= 2 &&
    ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'")))
  ) {
    name = name.slice(1, -1);
  }
  name = name.replace(/[/@*=|]$/, "");
  const parts = name.replaceAll("\\", "/").split("/");
  return parts.at(-1) ?? name;
}

function stripAnsi(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text.charCodeAt(index) !== 0x1b || text[index + 1] !== "[") {
      output += text[index] ?? "";
      index += 1;
      continue;
    }
    index += 2;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      index += 1;
      if (code >= 0x40 && code <= 0x7e) {
        break;
      }
    }
  }
  return output;
}
