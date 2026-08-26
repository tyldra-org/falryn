/** Hush version control and forge CLIs behavior. */

import { describe, expect, test } from "bun:test";
import { artifactId } from "../artifact.ts";
import { reduceHush } from "../index.ts";
import { argv, report } from "./fixtures.ts";

describe("Hush version control and forge CLIs", () => {
  test("git log keeps every requested commit and message fact in compact native form", () => {
    const output = [
      "commit 1111111111111111111111111111111111111111",
      "Author: Falryn <falryn@example.com>",
      "Date:   Sat Aug 23 12:00:00 2026 -0700",
      "",
      "    Preserve complete context",
      "",
      "    Keep the full body.",
      "",
      "commit 2222222222222222222222222222222222222222",
      "Author: Context Agent <context@example.com>",
      "Date:   Mon Aug 24 06:34:25 2026 -0700",
      "",
      "    Keep the final commit",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["log", "-2"]),
      capture: report(output, { artifact: true }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a Hush result");
    }
    expect(reduced.value.reducerId).toBe("git.log");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toBe(
      [
        "11111111 2026-08-23 Falryn | Preserve complete context",
        "",
        "  Keep the full body.",
        "22222222 2026-08-24 Context Agent | Keep the final commit",
        "",
      ].join("\n"),
    );
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
  });

  test("git show compacts metadata and keeps every validated patch line", () => {
    const output = [
      "commit 1111111111111111111111111111111111111111",
      "Author: Falryn <falryn@example.com>",
      "Date:   Sat Aug 23 12:00:00 2026 -0700",
      "",
      "    Preserve complete context",
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@ project",
      " export function project() {",
      "-  return 'sample';",
      "+  const complete = true;",
      "+  return complete ? 'hush' : 'sample';",
      " }",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["show", "HEAD", "--", "src/a.ts"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a Hush result");
    }
    expect(reduced.value.reducerId).toBe("git.log");
    expect(reduced.value.reducedText).toContain(
      "11111111 2026-08-23 Falryn | Preserve complete context\nsrc/a.ts:",
    );
    expect(reduced.value.reducedText).toContain("1111111..2222222 100644");
    expect(reduced.value.reducedText).toContain("@@ -1,3 +1,4 @@ project");
    expect(reduced.value.reducedText).toContain(" export function project() {");
    expect(reduced.value.reducedText).toContain("+  const complete = true;");
    expect(reduced.value.reducedText).not.toContain("--- a/src/a.ts");
    expect(reduced.value.reducedText).not.toContain("+++ b/src/a.ts");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("git log and show keep custom, failed, partial, and caller-pattern output exact", () => {
    const output = [
      "commit 1111111111111111111111111111111111111111",
      "Author: Falryn <falryn@example.com>",
      "Date:   Sat Aug 23 12:00:00 2026 -0700",
      "",
      "    Preserve complete context",
      "",
    ].join("\n");
    const cases = [
      {
        command: argv("git", ["log", "-1", "--format=fuller"]),
        capture: report(output),
        patterns: [] as readonly string[],
      },
      {
        command: argv("git", ["log", "-1"]),
        capture: report(output, { exitCode: 128, stderr: "fatal: bad revision\n" }),
        patterns: [] as readonly string[],
      },
      {
        command: argv("git", ["show", "HEAD"]),
        capture: report(output, { truncated: true }),
        patterns: [] as readonly string[],
      },
      {
        command: argv("git", ["log", "-1"]),
        capture: report(output),
        patterns: ["Preserve complete context"],
      },
    ];

    for (const fixture of cases) {
      const reduced = reduceHush({
        command: fixture.command,
        capture: fixture.capture,
        importantPatterns: fixture.patterns,
      });
      expect(reduced.ok).toBe(true);
      if (!reduced.ok) {
        throw new Error("expected a Hush result");
      }
      expect(reduced.value.reducedText).toContain(output);
      expect(reduced.value.reducedText).not.toContain("11111111 2026-08-23 Falryn |");
    }
  });

  test("git diff removes only validated duplicate paths while retaining every hunk line", () => {
    const diff = [
      "diff --git a/src/hush.ts b/src/hush.ts",
      "index 1111111..2222222 100644",
      "--- a/src/hush.ts",
      "+++ b/src/hush.ts",
      "@@ -1,3 +1,4 @@ reduceHush",
      " export function reduceHush() {",
      "-old",
      "-also",
      "+new",
      "+newer",
      "+newest",
      "diff --git a/src/other.ts b/src/other.ts",
      "index 3333333..4444444 100644",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["diff"]),
      capture: report(diff),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("git.diff");
    expect(reduced.value.reducedText).toContain("src/hush.ts:");
    expect(reduced.value.reducedText).toContain("src/other.ts:");
    expect(reduced.value.reducedText).toContain("1111111..2222222 100644");
    expect(reduced.value.reducedText).toContain("@@ -1,3 +1,4 @@ reduceHush");
    expect(reduced.value.reducedText).toContain(" export function reduceHush() {");
    expect(reduced.value.reducedText).toContain("-also");
    expect(reduced.value.reducedText).toContain("+newest");
    expect(reduced.value.reducedText).not.toContain("--- a/src/hush.ts");
    expect(reduced.value.reducedText).not.toContain("+++ b/src/hush.ts");
    expect(reduced.value.omissions).toEqual([]);
    expect(new TextEncoder().encode(reduced.value.reducedText).byteLength).toBeLessThan(
      new TextEncoder().encode(diff).byteLength,
    );
  });

  test("git diff keeps failed, partial, and caller-pattern captures exact", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const cases = [
      {
        capture: report(diff, { exitCode: 128, stderr: "fatal: bad revision\n" }),
        patterns: [] as readonly string[],
      },
      { capture: report(diff, { truncated: true }), patterns: [] as readonly string[] },
      { capture: report(diff), patterns: ["+new"] },
    ];

    for (const fixture of cases) {
      const reduced = reduceHush({
        command: argv("/usr/bin/git", ["diff"]),
        capture: fixture.capture,
        importantPatterns: fixture.patterns,
      });
      expect(reduced.ok).toBe(true);
      if (!reduced.ok) {
        throw new Error("expected a git diff Hush result");
      }
      expect(reduced.value.reducedText).toContain(diff);
      expect(reduced.value.reducedText).not.toContain("src/a.ts:\nindex");
    }
  });

  test("git status compacts the branch marker and keeps every porcelain path", () => {
    const lines = [
      "## main",
      ...Array.from({ length: 10 }, (_, index) => ` M src/hush/file${index}.ts`),
    ];
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["status", "--porcelain"]),
      capture: report(`${lines.join("\n")}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("git.status");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toContain("* main");
    expect(
      reduced.value.reducedText.split("\n").filter((line) => line.includes("src/hush/file")).length,
    ).toBe(10);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("reports a successful Git add without inventing staged counts", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["add", "."]),
      capture: report(""),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("git.mutation");
    expect(reduced.value.reducedText).toBe("ok");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps Git add dry-run paths because no staging occurred", () => {
    const output = "add 'src/a.ts'\nadd 'src/b.ts'\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["add", "--dry-run", "."]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(output);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("reports a successful Git commit with its durable identity", () => {
    const stdout = [
      "[feature/736 7654321] preserve complete context",
      " 3 files changed, 10 insertions(+), 2 deletions(-)",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["-C", "workspace", "commit", "-m", "change"]),
      capture: report(`${stdout}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("git.mutation");
    expect(reduced.value.reducedText).toBe("ok 7654321");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("retains Git commit failures instead of calling them ok", () => {
    const stdout = "On branch main\nnothing to commit, working tree clean\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["commit", "-m", "change"]),
      capture: report(stdout, { exitCode: 1 }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(stdout);
    expect(reduced.value.exit.exitCode).toBe(1);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps Git commit dry-run status because no commit occurred", () => {
    const stdout = "On branch main\nChanges to be committed:\n  new file: src/a.ts\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["commit", "--dry-run"]),
      capture: report(stdout),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(stdout);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("removes Git push progress while retaining its destination, ref, and range", () => {
    const stderr = [
      "Enumerating objects: 3, done.",
      "Writing objects: 100% (3/3), done.",
      "To github.com:yogeshprasad098/falryn.git",
      "   1111111..2222222  feature -> feature",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["push"]),
      capture: report("", { stderr: `${stderr}\n` }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("git.mutation");
    expect(reduced.value.reducedText).toBe(
      "push github.com:yogeshprasad098/falryn.git\nfeature 1111111..2222222",
    );
    expect(reduced.value.omissions).toEqual([]);
  });

  test("retains every Git push ref without a fixed ref-count cap", () => {
    const refs = Array.from(
      { length: 120 },
      (_, index) =>
        `   ${index.toString(16).padStart(7, "0")}..${(index + 1)
          .toString(16)
          .padStart(7, "0")}  feature-${index} -> feature-${index}`,
    );
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["push", "--all"]),
      capture: report("", {
        stderr: `To github.com:tyldra-org/falryn.git\n${refs.join("\n")}\n`,
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("feature-0 0000000..0000001");
    expect(reduced.value.reducedText).toContain("feature-119 0000077..0000078");
    expect(reduced.value.reducedText).not.toContain("omitted");
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("summarizes an up-to-date Git push without redundant lines", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["push"]),
      capture: report("", { stderr: "Everything up-to-date\n" }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe("ok up-to-date");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps Git push dry-run refs because nothing was pushed", () => {
    const stderr = [
      "To github.com:tyldra-org/falryn.git",
      "   1111111..2222222  feature -> feature",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["push", "--dry-run"]),
      capture: report("", { stderr }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(`stderr:\n${stderr}`);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps Git push warnings beside an up-to-date result", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["push"]),
      capture: report("", {
        stderr: "warning: redirecting to a canonical remote\nEverything up-to-date\n",
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(
      "ok up-to-date\nwarning: redirecting to a canonical remote",
    );
    expect(reduced.value.omissions).toEqual([]);
  });

  test("reports a successful Git pull with complete shortstat facts", () => {
    const stdout = [
      "Updating 1111111..2222222",
      "Fast-forward",
      " src/a.ts | 8 +++++---",
      " src/b.ts | 2 ++",
      " src/c.ts | 2 --",
      " 3 files changed, 10 insertions(+), 2 deletions(-)",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["pull", "--ff-only"]),
      capture: report(`${stdout}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("git.mutation");
    expect(reduced.value.reducedText).toBe("ok 3 files +10 -2");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("summarizes an up-to-date Git pull without duplicated wording", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["pull"]),
      capture: report("Already up to date.\n"),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe("ok up-to-date");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps Git pull dry-run fetch facts because nothing was integrated", () => {
    const stdout = "From github.com:tyldra-org/falryn\n * branch main -> FETCH_HEAD\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["pull", "--dry-run"]),
      capture: report(stdout),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(stdout);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("retains Git pull failures and their conflict context", () => {
    const stderr = "CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed.\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["pull"]),
      capture: report("", { stderr, exitCode: 1 }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("CONFLICT (content)");
    expect(reduced.value.reducedText).toContain("Automatic merge failed.");
    expect(reduced.value.exit.exitCode).toBe(1);
    expect(reduced.value.omissions).toEqual([]);
  });
});
