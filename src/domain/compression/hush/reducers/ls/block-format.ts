/** Remove per-entry inode noise while retaining every name and block count. */

type BlockEntry = Readonly<{
  blocks: string;
  name: string;
}>;

export function compactInodeBlockLs(text: string): string | null {
  const lines = listingLines(text);
  const total = /^total\s+(\d+)$/.exec(lines[0] ?? "")?.[1];
  if (total === undefined) {
    return null;
  }
  const entries: BlockEntry[] = [];
  for (const line of lines.slice(1)) {
    const match = /^\d+\s+(\d+)\s+(.+)$/.exec(line);
    const blocks = match?.[1];
    const name = match?.[2];
    if (blocks === undefined || name === undefined) {
      return null;
    }
    entries.push({ blocks, name });
  }
  if (entries.length === 0) {
    return null;
  }

  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    const names = groups.get(entry.blocks) ?? [];
    names.push(entry.name);
    groups.set(entry.blocks, names);
  }
  const output = [`blocks total=${total}`];
  for (const [blocks, names] of groups) {
    output.push(`${blocks} blocks (${names.length}):`, ...names);
  }
  return output.join("\n");
}

function listingLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
