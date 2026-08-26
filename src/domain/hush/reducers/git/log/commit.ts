/** Strict parser and compact renderer for Git's native medium commit format. */

const COMMIT_LINE = /^commit ([0-9a-f]{40,64})(?: (\(.+\)))?$/u;
const MERGE_LINE = /^Merge: ([0-9a-f]+(?: [0-9a-f]+)+)$/u;
const AUTHOR_LINE = /^Author: (.+)$/u;
const AUTHOR_WITH_EMAIL = /^(.+?) <[^<>\n]+>$/u;
const DATE_LINE = /^Date:\s{3}(.+)$/u;
const NATIVE_DATE =
  /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) \d{2}:\d{2}:\d{2} (\d{4}) [+-]\d{4}$/u;

const MONTH_NUMBER: Readonly<Record<string, string>> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

export type NativeGitCommit = Readonly<{
  hash: string;
  decoration: string | null;
  mergeParents: string | null;
  author: string;
  date: string;
  message: readonly string[];
}>;

export type ParsedGitCommit = Readonly<{
  commit: NativeGitCommit;
  nextLine: number;
}>;

export function parseNativeGitCommit(
  lines: readonly string[],
  startLine: number,
): ParsedGitCommit | null {
  const commitMatch = COMMIT_LINE.exec(lines[startLine] ?? "");
  if (commitMatch === null) {
    return null;
  }

  let index = startLine + 1;
  const mergeMatch = MERGE_LINE.exec(lines[index] ?? "");
  const mergeParents = mergeMatch?.[1] ?? null;
  if (mergeMatch !== null) {
    index += 1;
  }

  const authorMatch = AUTHOR_LINE.exec(lines[index] ?? "");
  if (authorMatch === null) {
    return null;
  }
  const author = authorName(authorMatch[1] ?? "");
  if (author === null) {
    return null;
  }
  index += 1;

  const dateMatch = DATE_LINE.exec(lines[index] ?? "");
  const date = compactNativeDate(dateMatch?.[1] ?? "");
  if (date === null || lines[index + 1] !== "") {
    return null;
  }
  index += 2;

  const message: string[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line === "") {
      message.push(line);
      index += 1;
      continue;
    }
    if (!line.startsWith("    ")) {
      break;
    }
    message.push(line.slice(4));
    index += 1;
  }
  while (message.at(-1) === "") {
    message.pop();
  }
  if (message.length === 0 || (message[0] ?? "").length === 0) {
    return null;
  }

  return {
    commit: {
      hash: commitMatch[1] ?? "",
      decoration: commitMatch[2] ?? null,
      mergeParents,
      author,
      date,
      message,
    },
    nextLine: index,
  };
}

export function renderNativeGitCommit(commit: NativeGitCommit): string {
  const identity = [commit.hash.slice(0, 8), commit.decoration, commit.date, commit.author]
    .filter((part): part is string => part !== null)
    .join(" ");
  const lines = [`${identity} | ${commit.message[0] ?? ""}`];
  if (commit.mergeParents !== null) {
    lines.push(`  merge ${commit.mergeParents}`);
  }
  for (const line of commit.message.slice(1)) {
    lines.push(line.length === 0 ? "" : `  ${line}`);
  }
  return lines.join("\n");
}

function authorName(source: string): string | null {
  if (source.length === 0 || source.includes("\0")) {
    return null;
  }
  return AUTHOR_WITH_EMAIL.exec(source)?.[1] ?? source;
}

function compactNativeDate(source: string): string | null {
  const match = NATIVE_DATE.exec(source);
  if (match === null) {
    return null;
  }
  const month = MONTH_NUMBER[match[1] ?? ""];
  const day = Number.parseInt(match[2] ?? "", 10);
  const year = match[3] ?? "";
  return month !== undefined && Number.isSafeInteger(day) && day >= 1 && day <= 31
    ? `${year}-${month}-${day.toString().padStart(2, "0")}`
    : null;
}
