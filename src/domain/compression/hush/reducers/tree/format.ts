/** Information-preserving compaction for the native textual `tree` format. */

import { parseNativeTree, parseNativeTreeLine } from "./parser.ts";
import { isTreeNoiseName } from "./policy.ts";
import { renderHushTree } from "./render.ts";

export { treeEntryFacts } from "./parser.ts";

const encoder = new TextEncoder();

export function compactTreeOutput(
  text: string,
  options: Readonly<{ directoriesOnly?: boolean; pruneNoise: boolean }>,
): string {
  const normalized = normalizeTreeOutput(text, options);
  const tree = parseNativeTree(normalized, options);
  if (tree === null || tree.entries.length === 0) {
    return normalized;
  }
  const structured = renderHushTree(tree);
  return encodedBytes(structured) <= encodedBytes(normalized) ? structured : normalized;
}

function normalizeTreeOutput(
  text: string,
  options: Readonly<{ directoriesOnly?: boolean; pruneNoise: boolean }>,
): string {
  const output: string[] = [];
  let prunedDepth: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (isTreeSummary(line)) {
      continue;
    }
    const parsed = parseNativeTreeLine(line);
    if (prunedDepth !== null) {
      if (parsed !== null && parsed.depth > prunedDepth) {
        continue;
      }
      prunedDepth = null;
    }
    if (parsed !== null && options.pruneNoise && isTreeNoiseName(parsed.label.name)) {
      prunedDepth = parsed.depth;
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
  return /^\s*\d+\s+director(?:y|ies)(?:,\s*\d+\s+files?)?\s*$/.test(line);
}

function encodedBytes(text: string): number {
  return encoder.encode(text).byteLength;
}
