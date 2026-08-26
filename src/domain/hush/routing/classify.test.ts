/** Hush rule matching behavior. */

import { describe, expect, test } from "bun:test";
import { classifyFamily, classifyReducerId } from "../../index.ts";
import { argv, bash, report } from "../fixtures.ts";
import { classifyCommand } from "./classify.ts";

describe("Hush rule matching", () => {
  test("returns the matched rule, normalized command, and match evidence", () => {
    expect(classifyCommand(bash("git status --short"), report(""))).toMatchObject({
      reducerId: "git.status",
      matched: true,
      matchedBy: "command-rule",
      tokens: ["git", "status", "--short"],
    });
    expect(classifyCommand(bash("git status && cargo test"), report(""))).toMatchObject({
      reducerId: "shell.compound",
      matched: true,
      matchedBy: "shell-compound",
    });
    expect(
      classifyCommand(argv("/usr/local/bin/tool"), report("src/hush.ts:12:reduceHush")),
    ).toMatchObject({
      reducerId: "files.search",
      matched: true,
      matchedBy: "output-shape",
    });
    expect(classifyCommand(argv("/usr/bin/unknown"), report("plain output"))).toMatchObject({
      reducerId: "generic",
      matched: false,
      matchedBy: "fallback",
    });
  });

  test("selects git from an argv executable rather than from output text", () => {
    expect(classifyFamily(argv("/usr/bin/git", ["status"]), report("not a git line"))).toBe("git");
  });

  test("selects git from a Bash command token", () => {
    expect(classifyFamily(bash("git status --short"), report(""))).toBe("git");
  });

  test("selects git.diff from the diff subcommand", () => {
    expect(classifyReducerId(["git", "diff"], "git")).toBe("git.diff");
  });

  test("selects test from bun test", () => {
    expect(classifyFamily(argv("/usr/bin/bun", ["test", "src"]), report(""))).toBe("test");
  });

  test("keeps established command families independent from projection policy", () => {
    expect(classifyFamily(argv("/usr/bin/docker", ["logs", "app"]), report(""))).toBe("container");
    expect(classifyFamily(argv("/usr/bin/kubectl", ["logs", "app"]), report(""))).toBe(
      "kubernetes",
    );
    expect(classifyFamily(argv("/usr/bin/tail", ["-n", "20", "app.log"]), report(""))).toBe("log");
    expect(classifyFamily(argv("/usr/bin/make", ["build"]), report(""))).toBe("build");
  });

  test("selects search from rg output shape only when the executable is unknown", () => {
    expect(classifyFamily(argv("/usr/local/bin/tool"), report("src/hush.ts:12:reduceHush"))).toBe(
      "search",
    );
  });
});
