/** Semantic compaction for portable BSD/GNU long `ls` rows. */

type LsEntryKind = "directory" | "file" | "link" | "other";

type LongLsEntry = Readonly<{
  kind: LsEntryKind;
  mode: string;
  name: string;
  size: string;
}>;

type LongLsSection = {
  label: string | null;
  entries: LongLsEntry[];
};

const LONG_ROW =
  /^([bcdlps-][rwxStTs-]{9}[+@.]?)\s+\d+\s+\S+\s+\S+\s+(\S+)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+(.*)$/;

const KIND_ORDER: Readonly<Record<LsEntryKind, number>> = {
  directory: 0,
  file: 1,
  link: 2,
  other: 3,
};

export function compactLongLs(text: string): string | null {
  const sections: LongLsSection[] = [];
  let current = section(null);
  sections.push(current);
  let parsedEntries = 0;

  for (const line of listingLines(text)) {
    if (line.length === 0 || /^total\s+\d+$/.test(line)) {
      continue;
    }
    const entry = parseLongLsEntry(line);
    if (entry !== null) {
      current.entries.push(entry);
      parsedEntries += 1;
      continue;
    }
    if (line.endsWith(":")) {
      current = section(line.slice(0, -1));
      sections.push(current);
      continue;
    }
    return null;
  }

  if (parsedEntries === 0) {
    return null;
  }

  const rendered = sections.flatMap(renderLongLsSection);
  return rendered.length > 0 ? rendered.join("\n") : "(empty)";
}

function section(label: string | null): LongLsSection {
  return { label, entries: [] };
}

function parseLongLsEntry(line: string): LongLsEntry | null {
  const match = LONG_ROW.exec(line);
  if (match === null) {
    return null;
  }
  const symbolicMode = match[1];
  const sourceSize = match[2];
  const name = match[3];
  if (symbolicMode === undefined || sourceSize === undefined || name === undefined) {
    return null;
  }
  return {
    kind: entryKind(symbolicMode[0] ?? "-"),
    mode: numericMode(symbolicMode),
    name,
    size: humanSize(sourceSize),
  };
}

function renderLongLsSection(value: LongLsSection): readonly string[] {
  const entries = value.entries.filter((entry) => entry.name !== "." && entry.name !== "..");
  if (entries.length === 0) {
    return [];
  }
  const lines = value.label === null ? [] : [`${value.label}:`];
  const groups = new Map<string, LongLsEntry[]>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.mode}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((left, right) => {
    const kind = KIND_ORDER[left[0]?.kind ?? "other"] - KIND_ORDER[right[0]?.kind ?? "other"];
    return kind !== 0 ? kind : (left[0]?.mode ?? "").localeCompare(right[0]?.mode ?? "");
  });
  for (const group of orderedGroups) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }
    lines.push(`${kindLabel(first.kind)} ${first.mode} (${group.length}):`);
    lines.push(...group.map(renderLongLsEntry));
  }
  return lines;
}

function renderLongLsEntry(entry: LongLsEntry): string {
  if (entry.kind === "directory") {
    return entry.name.endsWith("/") ? entry.name : `${entry.name}/`;
  }
  return `${entry.name} ${entry.size}`;
}

function entryKind(type: string): LsEntryKind {
  switch (type) {
    case "d":
      return "directory";
    case "-":
      return "file";
    case "l":
      return "link";
    default:
      return "other";
  }
}

function kindLabel(kind: LsEntryKind): string {
  switch (kind) {
    case "directory":
      return "dirs";
    case "file":
      return "files";
    case "link":
      return "links";
    case "other":
      return "other";
  }
}

function numericMode(symbolic: string): string {
  const permissions = symbolic.slice(1, 10);
  const special =
    (/[sS]/.test(permissions[2] ?? "") ? 4 : 0) +
    (/[sS]/.test(permissions[5] ?? "") ? 2 : 0) +
    (/[tT]/.test(permissions[8] ?? "") ? 1 : 0);
  const digits = [0, 3, 6].map((start) => permissionDigit(permissions.slice(start, start + 3)));
  return `${special === 0 ? "" : special}${digits.join("")}`;
}

function permissionDigit(value: string): number {
  return (
    (value[0] === "r" ? 4 : 0) +
    (value[1] === "w" ? 2 : 0) +
    (/[xst]/i.test(value[2] ?? "") ? 1 : 0)
  );
}

function humanSize(source: string): string {
  if (!/^\d+$/.test(source)) {
    return source;
  }
  const bytes = Number(source);
  if (!Number.isSafeInteger(bytes) || bytes < 1_024) {
    return `${source}B`;
  }
  const units = ["K", "M", "G", "T", "P"] as const;
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)}${units[unitIndex] ?? "B"}`;
}

function listingLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
