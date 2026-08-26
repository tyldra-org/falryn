import { describe, expect, test } from "bun:test";

import { gitSubcommand, gitSubcommandArguments } from "./git.ts";

describe("Git command parsing", () => {
  test("finds the subcommand after value-taking global options", () => {
    const tokens = ["git", "-C", "workspace", "-c", "color.ui=false", "commit", "-m", "change"];
    expect(gitSubcommand(tokens)).toBe("commit");
    expect(gitSubcommandArguments(tokens)).toEqual(["-m", "change"]);
  });

  test("finds the subcommand after inline values and global flags", () => {
    const tokens = ["git", "--no-pager", "--git-dir=.git", "push", "origin", "main"];
    expect(gitSubcommand(tokens)).toBe("push");
    expect(gitSubcommandArguments(tokens)).toEqual(["origin", "main"]);
  });

  test("returns no subcommand when a global option has no value", () => {
    expect(gitSubcommand(["git", "-C"])).toBe("");
    expect(gitSubcommandArguments(["git", "-C"])).toEqual([]);
  });
});
