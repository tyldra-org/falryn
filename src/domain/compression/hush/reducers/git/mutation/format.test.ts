import { describe, expect, test } from "bun:test";

import { formatGitBranchList } from "./branch.ts";
import { formatGitCheckoutSuccess } from "./checkout.ts";
import { formatGitFetchSuccess } from "./fetch.ts";
import { formatGitStashCreation, formatGitStashList } from "./stash.ts";
import { formatGitWorktreeList } from "./worktree.ts";

describe("Git mutation formats", () => {
  test("keeps every branch and its checkout or worktree marker", () => {
    const source = Array.from({ length: 120 }, (_, index) => {
      const marker = index === 0 ? "*" : index === 119 ? "+" : " ";
      return `${marker} branch/${index + 1}`;
    }).join("\n");
    const formatted = formatGitBranchList(`${source}\n`);

    expect(formatted?.split("\n")).toHaveLength(120);
    expect(formatted).toStartWith("* branch/1\nbranch/2");
    expect(formatted).toEndWith("+ branch/120");
    expect(formatted).not.toContain("omitted");
  });

  test("refuses malformed branch rows", () => {
    expect(formatGitBranchList("main\n")).toBeNull();
  });

  test("compacts only complete checkout success messages", () => {
    expect(formatGitCheckoutSuccess("Switched to a new branch 'feature/736'")).toBe(
      "ok feature/736 new",
    );
    expect(formatGitCheckoutSuccess("Switched to branch 'main'")).toBe("ok main");
    expect(formatGitCheckoutSuccess("Already on 'main'")).toBe("ok main");
    expect(formatGitCheckoutSuccess("HEAD is now at 1234567890abcdef subject")).toBe(
      "ok HEAD 12345678",
    );
    expect(formatGitCheckoutSuccess("Updated 2 paths from the index")).toBe("ok restored 2");
    expect(formatGitCheckoutSuccess("warning: unexpected checkout detail")).toBeNull();
  });

  test("counts every fetched ref without imposing an item cap", () => {
    const refs = Array.from({ length: 120 }, (_, index) => {
      const before = (index + 1).toString(16).padStart(7, "0");
      const after = (index + 2).toString(16).padStart(7, "0");
      return `${before}..${after} branch/${index + 1} -> origin/branch/${index + 1}`;
    });

    expect(formatGitFetchSuccess(["From github.com:tyldra-org/falryn", ...refs])).toBe(
      "fetched 120 refs",
    );
    expect(formatGitFetchSuccess(["warning: forced update checking disabled"])).toBeNull();
  });

  test("keeps every stash index, branch, and message", () => {
    const source = Array.from(
      { length: 120 },
      (_, index) => `stash@{${index}}: On branch/${index}: Preserve fact ${index}`,
    ).join("\n");
    const formatted = formatGitStashList(`${source}\n`);

    expect(formatted?.split("\n")).toHaveLength(120);
    expect(formatted).toStartWith("0 branch/0 | Preserve fact 0");
    expect(formatted).toEndWith("119 branch/119 | Preserve fact 119");
    expect(formatGitStashCreation("No local changes to save")).toBe("nothing to stash");
    expect(
      formatGitStashCreation("Saved working directory and index state On main: checkpoint"),
    ).toBe("stashed");
  });

  test("keeps every worktree, full path, revision, and state", () => {
    const source = Array.from({ length: 120 }, (_, index) => {
      const hash = (index + 1).toString(16).padStart(7, "0");
      return `/workspace/falryn-${index} ${hash} [branch/${index}]`;
    }).join("\n");
    const formatted = formatGitWorktreeList(`${source}\n`, "/workspace/falryn-0");

    expect(formatted?.split("\n")).toHaveLength(120);
    expect(formatted).toStartWith(". 0000001 [branch/0]");
    expect(formatted).toEndWith("/workspace/falryn-119 0000078 [branch/119]");
    expect(formatted).not.toContain("omitted");
  });
});
