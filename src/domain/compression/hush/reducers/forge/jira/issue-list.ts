import { shortestText, stripAnsi } from "../../shared/text.ts";

const JIRA_ISSUE_COLUMNS = [
  "TYPE",
  "KEY",
  "SUMMARY",
  "STATUS",
  "ASSIGNEE",
  "REPORTER",
  "PRIORITY",
  "RESOLUTION",
  "CREATED",
  "UPDATED",
  "LABELS",
] as const;

/** Preserve every returned Jira issue and cell while removing alignment padding. */
export function formatJiraIssueList(text: string): string | null {
  const source = stripAnsi(text);
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const header = lines[0];
  if (header === undefined || lines.some((line) => line.length === 0)) {
    return null;
  }
  const starts = columnStarts(header);
  if (starts === null) {
    return null;
  }
  const rows = lines.slice(1).map((line) => rowCells(line, starts));
  if (
    !rows.every(
      (row): row is readonly string[] =>
        row !== null &&
        row[0]?.length !== 0 &&
        row[1]?.length !== 0 &&
        row[2]?.length !== 0 &&
        row[3]?.length !== 0,
    )
  ) {
    return null;
  }
  const formatted = [JIRA_ISSUE_COLUMNS.join("\t"), ...rows.map((row) => row.join("\t"))].join(
    "\n",
  );
  return shortestText(source, formatted);
}

function columnStarts(header: string): readonly number[] | null {
  const starts: number[] = [];
  let cursor = 0;
  for (const column of JIRA_ISSUE_COLUMNS) {
    const start = header.indexOf(column, cursor);
    if (start < cursor || header.slice(cursor, start).trim().length !== 0) {
      return null;
    }
    starts.push(start);
    cursor = start + column.length;
  }
  return header.slice(cursor).trim().length === 0 ? starts : null;
}

function rowCells(line: string, starts: readonly number[]): readonly string[] | null {
  const points = Array.from(line);
  const cells = starts.map((start, index) =>
    points
      .slice(start, starts[index + 1])
      .join("")
      .trim(),
  );
  return cells.length === JIRA_ISSUE_COLUMNS.length ? cells : null;
}
