import { describe, expect, test } from "bun:test";

import { hasJiraOutputOverride, jiraCommand, jiraCommandArguments } from "./jira-command.ts";

describe("Jira command shapes", () => {
  test("recognizes issue list and view without claiming other Jira commands", () => {
    expect(jiraCommand(["jira", "issue", "list"])).toBe("issue-list");
    expect(jiraCommand(["jira", "issue", "view", "FAL-736"])).toBe("issue-view");
    expect(jiraCommand(["jira", "issue", "create"])).toBeNull();
    expect(jiraCommand(["jira", "sprint", "list"])).toBeNull();
  });

  test("returns only arguments after the recognized command", () => {
    expect(jiraCommandArguments(["jira", "issue", "view", "FAL-736", "--comments", "5"])).toEqual([
      "FAL-736",
      "--comments",
      "5",
    ]);
  });

  test("preserves explicit caller-owned presentation formats", () => {
    expect(hasJiraOutputOverride(["--raw"])).toBe(true);
    expect(hasJiraOutputOverride(["--columns=key,status"])).toBe(true);
    expect(hasJiraOutputOverride(["--comments", "5"])).toBe(false);
  });
});
