/** Hush-native tree rendering optimized for model-readable path context. */

import type { ParsedTree, TreeEntry } from "./parser.ts";

export function renderHushTree(tree: ParsedTree): string {
  const sections = new Map<string, TreeEntry[]>();
  for (const entry of tree.entries) {
    const separator = entry.path.lastIndexOf("/");
    const parent = separator === -1 ? "" : entry.path.slice(0, separator);
    const children = sections.get(parent) ?? [];
    children.push(entry);
    sections.set(parent, children);
  }

  const output = [`${tree.root}/`];
  for (const [path, entries] of sections) {
    output.push(path.length === 0 ? "./:" : `${path}/:`);
    output.push(...entries.map(renderEntry));
  }
  return `${output.join("\n")}\n`;
}

function renderEntry(entry: TreeEntry): string {
  const metadata = entry.metadata.length === 0 ? "" : `${entry.metadata.join(" ")} `;
  const suffix = entry.directory ? "/" : entry.marker;
  const target = entry.target === null ? "" : ` -> ${entry.target}`;
  return `  ${metadata}${entry.name}${suffix}${target}`;
}
