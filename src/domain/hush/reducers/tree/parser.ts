/** Parsing shared by native `tree` input and Hush's model-facing tree format. */

export type TreeEntry = Readonly<{
  directory: boolean;
  metadata: readonly string[];
  marker: string;
  name: string;
  path: string;
  target: string | null;
}>;

export type ParsedTree = Readonly<{
  entries: readonly TreeEntry[];
  root: string;
}>;

type ParsedLabel = Readonly<{
  directoryHint: boolean;
  metadata: readonly string[];
  marker: string;
  name: string;
  target: string | null;
}>;

export type ParsedNativeTreeLine = Readonly<{
  depth: number;
  label: ParsedLabel;
}>;

const TREE_ENTRY = /^((?:(?:│ {3}|\| {3}| {4}))*)(?:├── |└── |\|-- |`-- |\\-- |\+-- )(.*)$/u;

export function parseNativeTree(
  text: string,
  options: Readonly<{ directoriesOnly?: boolean }> = {},
): ParsedTree | null {
  const lines = nonEmptyTrailingLines(text);
  const rootLine = lines.shift();
  if (rootLine === undefined || rootLine.length === 0) {
    return null;
  }
  if (lines.some((line) => line.trim().length === 0)) {
    return null;
  }

  const parsed = lines.map(parseNativeTreeLine);
  if (parsed.some((entry) => entry === null)) {
    return null;
  }

  const ancestors: string[] = [];
  const entries: TreeEntry[] = [];
  const nativeEntries = parsed.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  for (const [index, entry] of nativeEntries.entries()) {
    if (entry.depth > ancestors.length) {
      return null;
    }
    ancestors.length = entry.depth;
    const next = nativeEntries[index + 1];
    const directory =
      options.directoriesOnly === true ||
      entry.label.directoryHint ||
      (next !== undefined && next.depth > entry.depth);
    const path = [...ancestors, entry.label.name].join("/");
    entries.push({
      directory,
      metadata: entry.label.metadata,
      marker: entry.label.marker,
      name: entry.label.name,
      path,
      target: entry.label.target,
    });
    if (directory) {
      ancestors[entry.depth] = entry.label.name;
    }
  }

  return {
    entries,
    root: stripAnsi(rootLine).trim().replace(/\/$/, ""),
  };
}

export function parseHushTree(text: string): ParsedTree | null {
  const lines = nonEmptyTrailingLines(text);
  const rootLine = lines.shift();
  if (rootLine === undefined || !rootLine.endsWith("/") || lines[0] !== "./:") {
    return null;
  }

  const entries: TreeEntry[] = [];
  let section: string | null = null;
  for (const line of lines) {
    if (!line.startsWith("  ")) {
      if (!line.endsWith("/:") || line.length < 3) {
        return null;
      }
      section = line === "./:" ? "" : line.slice(0, -2);
      continue;
    }
    if (section === null) {
      return null;
    }
    const label = parseLabel(line.slice(2));
    if (label === null) {
      return null;
    }
    const path = section.length === 0 ? label.name : `${section}/${label.name}`;
    entries.push({
      directory: label.directoryHint,
      metadata: label.metadata,
      marker: label.marker,
      name: label.name,
      path,
      target: label.target,
    });
  }

  return {
    entries,
    root: rootLine.slice(0, -1),
  };
}

export function treeEntryFacts(
  text: string,
  options: Readonly<{ directoriesOnly?: boolean }> = {},
): readonly string[] | null {
  const tree = parseHushTree(text) ?? parseNativeTree(text, options);
  if (tree === null) {
    return null;
  }
  const siblingCounts = new Map<string, number>();
  const facts = tree.entries.map((entry) => {
    const separator = entry.path.lastIndexOf("/");
    const parent = separator === -1 ? "" : entry.path.slice(0, separator);
    const siblingIndex = siblingCounts.get(parent) ?? 0;
    siblingCounts.set(parent, siblingIndex + 1);
    return JSON.stringify([
      entry.path,
      entry.directory ? "directory" : "file",
      entry.metadata,
      entry.directory ? "" : entry.marker,
      entry.target,
      siblingIndex,
    ]);
  });
  return [JSON.stringify([".", "directory", [], null, tree.root]), ...facts.sort()];
}

export function parseNativeTreeLine(line: string): ParsedNativeTreeLine | null {
  const match = TREE_ENTRY.exec(line);
  const indent = match?.[1];
  const displayName = match?.[2];
  if (indent === undefined || displayName === undefined) {
    return null;
  }
  const label = parseLabel(displayName);
  return label === null ? null : { depth: indent.length / 4, label };
}

function parseLabel(displayName: string): ParsedLabel | null {
  let value = stripAnsi(displayName).trim();
  const metadata: string[] = [];
  while (value.startsWith("[")) {
    const match = /^(\[[^\]]*\])\s*/.exec(value);
    const field = match?.[1];
    if (match === null || field === undefined) {
      return null;
    }
    metadata.push(field);
    value = value.slice(match[0].length);
  }

  const targetIndex = value.indexOf(" -> ");
  const target = targetIndex === -1 ? null : value.slice(targetIndex + 4).trim();
  let source = (targetIndex === -1 ? value : value.slice(0, targetIndex)).trim();
  const suffix = /[/@*=|]$/.exec(source)?.[0] ?? "";
  if (suffix.length > 0) {
    source = source.slice(0, -1);
  }
  if (
    source.length >= 2 &&
    ((source.startsWith('"') && source.endsWith('"')) ||
      (source.startsWith("'") && source.endsWith("'")))
  ) {
    source = source.slice(1, -1);
  }
  const name = baseName(source);
  if (name.length === 0) {
    return null;
  }
  return {
    directoryHint: suffix === "/" || metadata.some((field) => field.startsWith("[d")),
    metadata,
    marker: suffix,
    name,
    target,
  };
}

function baseName(value: string): string {
  const parts = value.replaceAll("\\", "/").split("/");
  return parts.at(-1) ?? value;
}

function nonEmptyTrailingLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.at(-1)?.length === 0) {
    lines.pop();
  }
  return lines;
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
