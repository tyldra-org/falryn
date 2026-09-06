import { describe, expect, test } from "bun:test";

import { formatJiraIssueList } from "./issue-list.ts";
import { formatJiraIssueView } from "./issue-view.ts";

const ISSUE_COLUMNS = [
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

describe("Hush Jira formats", () => {
  test("keeps every issue and every returned column without a row cap", () => {
    const rows = Array.from({ length: 75 }, (_, index) => [
      index % 2 === 0 ? "Task" : "Bug",
      `FAL-${700 + index}`,
      `Preserve complete issue ${index}`,
      index === 74 ? "In Progress" : "To Do",
      "Yogesh Prasad",
      "Falryn Agent",
      index === 74 ? "Highest" : "High",
      index === 74 ? "" : "Unresolved",
      "2026-08-24 08:30:00",
      "2026-08-25 09:40:00",
      `context,priority:P${index % 4}`,
    ]);
    const formatted = formatJiraIssueList(alignedTable(ISSUE_COLUMNS, rows));
    expect(formatted?.split("\n")).toHaveLength(76);
    expect(formatted).toStartWith(`${ISSUE_COLUMNS.join("\t")}\n`);
    expect(formatted).toContain(
      "Task\tFAL-700\tPreserve complete issue 0\tTo Do\tYogesh Prasad\tFalryn Agent\tHigh\tUnresolved\t2026-08-24 08:30:00\t2026-08-25 09:40:00\tcontext,priority:P0",
    );
    expect(formatted).toContain(
      "Task\tFAL-774\tPreserve complete issue 74\tIn Progress\tYogesh Prasad\tFalryn Agent\tHighest\t\t2026-08-24 08:30:00\t2026-08-25 09:40:00\tcontext,priority:P2",
    );
    expect(formatted).not.toContain("omitted");
  });

  test("keeps section identity and meaningful paragraph boundaries", () => {
    const formatted = formatJiraIssueView(
      [
        "Task  In Progress  Sun, 23 Aug 26  Yogesh Prasad  FAL-736  3 comments  2 linked",
        "# Optimize context engines",
        "Tue, 25 Aug 26  Yogesh Prasad  High  Context Platform  context, performance",
        "",
        "------------------------ Description ------------------------",
        "",
        "Preserve every useful fact.",
        "",
        "Reduce presentation noise without hiding context.",
        "",
        "------------------------ 2 Subtasks ------------------------",
        "",
        "FAL-788 Wire live index candidates • Highest • To Do",
        "FAL-806 Expose bounded capability bridge • Normal • Done",
        "",
        "View this issue on Jira: https://jira.example.test/browse/FAL-736",
        "",
      ].join("\n"),
    );
    expect(formatted).toBe(
      [
        "Task\tIn Progress\tSun, 23 Aug 26\tYogesh Prasad\tFAL-736\t3 comments\t2 linked",
        "# Optimize context engines",
        "Tue, 25 Aug 26\tYogesh Prasad\tHigh\tContext Platform\tcontext, performance",
        "Description:",
        "Preserve every useful fact.",
        "",
        "Reduce presentation noise without hiding context.",
        "2 Subtasks:",
        "FAL-788 Wire live index candidates • Highest • To Do",
        "FAL-806 Expose bounded capability bridge • Normal • Done",
        "https://jira.example.test/browse/FAL-736",
      ].join("\n"),
    );
  });

  test("declines unfamiliar or partial layouts instead of guessing", () => {
    expect(formatJiraIssueList("KEY  SUMMARY\nFAL-1  Incomplete\n")).toBeNull();
    expect(formatJiraIssueView("FAL-1 changed its output shape\n")).toBeNull();
  });
});

function alignedTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return `${[headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd((widths[index] ?? cell.length) + 2),
        )
        .join(""),
    )
    .join("\n")}\n`;
}
