import { describe, expect, test } from "bun:test";

import { formatGraphiteLog } from "./log.ts";
import { formatGraphiteMutation } from "./mutation.ts";
import { formatGraphiteSubmit } from "./submit.ts";

describe("Hush Graphite formats", () => {
  test("keeps every branch, commit, message, and age without a cap", () => {
    const output = Array.from({ length: 75 }, (_, index) =>
      [
        `${index === 0 ? "◉" : "◯"} feature/${index}${index === 0 ? " (current)" : ""}`,
        `│ ${index + 1} minutes ago`,
        "│",
        `│ ${String(index).padStart(7, "0")} - Preserve branch fact ${index}`,
      ].join("\n"),
    ).join("\n");
    const formatted = formatGraphiteLog(output);
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain("* feature/0 0000000 Preserve branch fact 0 | 1 minutes ago");
    expect(formatted).toContain("  feature/74 0000074 Preserve branch fact 74 | 75 minutes ago");
    expect(formatted).not.toContain("omitted");
  });

  test("keeps every submitted branch action and URL", () => {
    const prepared = Array.from({ length: 75 }, (_, index) => `▸ feature/${index} (Update)`);
    const terminal = Array.from(
      { length: 75 },
      (_, index) =>
        `feature/${index}: https://app.graphite.dev/github/pr/example/repo/${100 + index} (updated)`,
    );
    const formatted = formatGraphiteSubmit(
      [
        "🥞 Validating that this Graphite stack is ready to submit...",
        "📝 Preparing to submit PRs for the following branches...",
        ...prepared,
        "📨 Pushing to remote and creating/updating PRs...",
        ...terminal,
      ].join("\n"),
    );
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain(
      "updated feature/74 https://app.graphite.dev/github/pr/example/repo/174",
    );
  });

  test("compacts complete sync, restack, create, and branch facts", () => {
    expect(
      formatGraphiteMutation(
        "sync",
        [
          "🌲 Fetching latest changes from remote...",
          "main is up to date.",
          "🧹 Cleaning up merged branches...",
          "Deleted feature/merged (PR #98 was merged).",
          "🔄 Restacking branches...",
          "Restacked feature/base on main.",
          "Restacked feature/top on feature/base.",
        ].join("\n"),
      ),
    ).toBe(
      "sync main up to date\ndeleted feature/merged (#98 merged)\nrestacked feature/base -> main\nrestacked feature/top -> feature/base",
    );
    expect(
      formatGraphiteMutation(
        "restack",
        "🔄 Restacking branches...\nRestacked feature/base on main.\nRestacked feature/top on feature/base.\n",
      ),
    ).toBe("restacked feature/base -> main\nrestacked feature/top -> feature/base");
    expect(
      formatGraphiteMutation(
        "create",
        "Created branch feature/demo on main.\n[feature/demo abc1234] Preserve complete context\n 2 files changed, 6 insertions(+), 1 deletion(-)\n",
      ),
    ).toBe("created feature/demo -> main\nabc1234 Preserve complete context\n2 files +6 -1");
    expect(
      formatGraphiteMutation("branch", "◉ feature/top (current)\n◯ feature/base\n◯ main\n"),
    ).toBe("* feature/top\n  feature/base\n  main");
  });

  test("declines prompts, conflicts, and unknown lines", () => {
    expect(formatGraphiteSubmit("? Title > Preserve context\n")).toBeNull();
    expect(formatGraphiteMutation("restack", "CONFLICT: resolve src/a.ts\n")).toBeNull();
    expect(formatGraphiteLog("Graphite changed this shape\n")).toBeNull();
  });
});
