import { stripAnsi } from "../../../text-format.ts";

type GraphiteLogRow = Readonly<{
  branch: string;
  current: boolean;
  age: string | null;
  commit: string | null;
}>;

/** Collapse Graphite's vertical graph without dropping a branch, commit, message, or age. */
export function formatGraphiteLog(text: string): string | null {
  const lines = normalizedLines(text);
  if (lines.length === 0) {
    return "";
  }
  const rows: GraphiteLogRow[] = [];
  let row: GraphiteLogRow | null = null;
  for (const line of lines) {
    const header = /^[◉◯]\s+(.+?)(?:\s+\(current\))?$/u.exec(line);
    if (header !== null) {
      if (row !== null) {
        rows.push(row);
      }
      const branch = header[1];
      if (branch === undefined || branch.length === 0) {
        return null;
      }
      row = { branch, current: line.includes("(current)"), age: null, commit: null };
      continue;
    }
    if (line === "│") {
      continue;
    }
    const detail = /^│\s+(.+)$/u.exec(line)?.[1];
    if (row === null || detail === undefined) {
      return null;
    }
    if (/^[0-9a-f]{7,40}\s+-\s+.+$/iu.test(detail)) {
      if (row.commit !== null) {
        return null;
      }
      row = { ...row, commit: detail.replace(/\s+-\s+/u, " ") };
    } else if (row.age === null) {
      row = { ...row, age: detail };
    } else {
      return null;
    }
  }
  if (row !== null) {
    rows.push(row);
  }
  if (rows.length === 0) {
    return null;
  }
  return rows
    .map((entry) => {
      const facts = [
        entry.branch,
        entry.commit,
        entry.age === null ? null : `| ${entry.age}`,
      ].filter((fact): fact is string => fact !== null);
      return `${entry.current ? "*" : " "} ${facts.join(" ")}`;
    })
    .join("\n");
}

function normalizedLines(text: string): readonly string[] {
  return stripAnsi(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
