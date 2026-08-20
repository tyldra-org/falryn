/**
 * Grouping and tab rows for the Git changes dashboard.
 */

import { describe, expect, test } from "bun:test";
import { type GitIdentity, type GitStatusEntry, instant, localPath } from "../../domain/index.ts";
import { changesDashboardFrom, rowsForTab } from "./dashboard.ts";

function identity(): GitIdentity {
  return {
    worktreeRoot: localPath("/repo"),
    gitDir: ".git",
    commonDir: ".git",
    head: { state: "observed", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    headState: "branch",
    branch: { state: "observed", value: "main" },
    upstream: { state: "unavailable", reason: "none" },
    ahead: { state: "unavailable", reason: "none" },
    behind: { state: "unavailable", reason: "none" },
    operation: "clean",
    superproject: { state: "unavailable", reason: "no-superproject" },
    sparseCheckout: { state: "observed", value: false },
    gitVersion: { state: "observed", value: "2.45.0" },
    remotes: { state: "observed", value: [] },
    observedAt: instant(0),
  };
}

function entry(
  path: string,
  kind: GitStatusEntry["kind"],
  indexStatus: string,
  worktreeStatus: string,
): GitStatusEntry {
  return { kind, path, originalPath: null, indexStatus, worktreeStatus };
}

describe("changesDashboardFrom", () => {
  test("groups conflict, staged, unstaged, untracked, and ignored paths", () => {
    const model = changesDashboardFrom({
      identity: identity(),
      entries: [
        entry("conflict.ts", "unmerged", "U", "U"),
        entry("staged.ts", "ordinary", "M", "."),
        entry("unstaged.ts", "ordinary", ".", "M"),
        entry("both.ts", "ordinary", "M", "M"),
        entry("new.ts", "untracked", "?", "?"),
        entry("skip.ts", "ignored", "!", "!"),
        entry("clean.ts", "ordinary", ".", "."),
      ],
      entriesNote: "1 more omitted.",
      worktrees: [
        {
          path: "/repo",
          head: { state: "observed", value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          branch: { state: "observed", value: "main" },
          detached: false,
          locked: false,
          prunable: false,
        },
      ],
      worktreesNote: null,
      checkpoints: [
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          headState: "branch",
          branch: "main",
          indexTree: "c",
          worktreeTree: "d",
          includedUntracked: [],
          excludedUntracked: 2,
          truncated: true,
          sessionId: null,
          turnId: null,
        },
      ],
      checkpointsNote: null,
    });

    expect(model.branch).toBe("main");
    expect(model.groups.map((group) => group.bucket)).toEqual([
      "conflict",
      "staged",
      "unstaged",
      "untracked",
      "ignored",
    ]);
    expect(rowsForTab(model, "files")).toEqual([
      "conflict conflict.ts",
      "staged staged.ts",
      "staged both.ts",
      "unstaged unstaged.ts",
      "unstaged both.ts",
      "untracked new.ts",
      "ignored skip.ts",
    ]);
    expect(rowsForTab(model, "worktrees")).toEqual(["main /repo"]);
    expect(rowsForTab(model, "checkpoints")[0]).toContain("bbbbbbbbbbbb");
    expect(model.entriesNote).toBe("1 more omitted.");
  });
});
