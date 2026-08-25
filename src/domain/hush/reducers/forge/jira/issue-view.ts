import { shortestText, stripAnsi } from "../../../text-format.ts";

const SECTION = /^-{8,}\s+(.+?)\s+-{8,}$/u;
const JIRA_URL = /^View this issue on Jira:\s+(https?:\/\/\S+)$/u;

/** Keep issue metadata and Markdown content while removing pager-oriented decoration. */
export function formatJiraIssueView(text: string): string | null {
  const source = stripAnsi(text);
  const lines = source.split("\n").map((line) => line.trimEnd());
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const heading = lines[1];
  const primary = lines[0] === undefined ? null : compactMetadata(lines[0]);
  const secondary = lines[2] === undefined ? null : compactMetadata(lines[2]);
  if (
    primary === null ||
    secondary === null ||
    heading === undefined ||
    !heading.startsWith("# ")
  ) {
    return null;
  }

  let sawSection = false;
  const body = lines.slice(3).map((line) => {
    const section = SECTION.exec(line)?.[1];
    if (section !== undefined) {
      sawSection = true;
      return `${section}:`;
    }
    if (/^-{8,}/u.test(line)) {
      return null;
    }
    const url = JIRA_URL.exec(line)?.[1];
    return url ?? line;
  });
  if (!sawSection || !body.every((line): line is string => line !== null)) {
    return null;
  }
  const formatted = compactBlankLines([primary, heading, secondary, ...body]).join("\n");
  return shortestText(source, formatted);
}

function compactMetadata(line: string): string | null {
  const cells = line
    .trim()
    .split(/\s{2,}/u)
    .map((cell) => cell.trim());
  return cells.length < 2 || cells.some((cell) => cell.length === 0) ? null : cells.join("\t");
}

function compactBlankLines(lines: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.length > 0) {
      result.push(line);
      continue;
    }
    const previous = result.at(-1);
    const next = lines[index + 1];
    if (
      previous === undefined ||
      previous.length === 0 ||
      previous.endsWith(":") ||
      next === undefined ||
      next.endsWith(":") ||
      /^https?:\/\//u.test(next)
    ) {
      continue;
    }
    result.push("");
  }
  return result;
}
