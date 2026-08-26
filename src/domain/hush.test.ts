/**
 * Hush reducers over captured process facts.
 */

import { describe, expect, test } from "bun:test";

import { artifactId } from "./artifact.ts";
import { duration, instant } from "./clock.ts";
import {
  classifyFamily,
  classifyReducerId,
  createHushPort,
  DEFAULT_HUSH_REDUCED_BYTES,
  HUSH_REDUCER_VERSION,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_HUSH_REDUCED_BYTES,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  processCaptureId,
  reduceHush,
} from "./index.ts";

const encoder = new TextEncoder();

function argv(executable: string, args: readonly string[] = []): ProcessCaptureRequest {
  return {
    executable,
    argv: args,
    environment: { SECRET: "do-not-copy" },
    cwd: "/workspace",
    timeoutMs: duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

function bash(command: string): ProcessCaptureRequest {
  return {
    mode: "bash",
    executable: "/bin/bash",
    command,
    environment: { SECRET: "do-not-copy" },
    timeoutMs: duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

function report(
  stdout: string,
  overrides: {
    readonly stderr?: string;
    readonly encoding?: "utf-8" | "binary";
    readonly truncated?: boolean;
    readonly artifact?: boolean;
    readonly exitCode?: number | null;
    readonly stop?: ProcessCaptureReport["stop"];
    readonly durationMs?: number;
  } = {},
): ProcessCaptureReport {
  const stdoutBytes = encoder.encode(stdout);
  const stderrText = overrides.stderr ?? "";
  const stderrBytes = encoder.encode(stderrText);
  return {
    captureId: processCaptureId.from("cap-1"),
    pid: 42,
    startedAt: instant(1_000),
    endedAt: instant(1_000 + (overrides.durationMs ?? 12)),
    durationMs: duration(overrides.durationMs ?? 12),
    stop: overrides.stop ?? { kind: "exited" },
    killStage: "none",
    exit: { exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode, signal: null },
    stdout: {
      stream: "stdout",
      byteCount: stdoutBytes.byteLength,
      inlineBytes: stdoutBytes,
      inlineText: overrides.encoding === "binary" ? null : stdout,
      encoding: overrides.encoding ?? "utf-8",
      truncated: overrides.truncated ?? false,
      omittedBytes: 0,
      maxLineExceeded: false,
      artifact: overrides.artifact
        ? {
            artifactId: artifactId.from("cap-1.stdout"),
            committed: true,
            truncated: false,
            byteLength: stdoutBytes.byteLength,
          }
        : null,
    },
    stderr: {
      stream: "stderr",
      byteCount: stderrBytes.byteLength,
      inlineBytes: stderrBytes,
      inlineText: stderrText,
      encoding: "utf-8",
      truncated: false,
      omittedBytes: 0,
      maxLineExceeded: false,
      artifact: null,
    },
    events: [],
  };
}

describe("hush request contracts", () => {
  test("rejects a reduced-byte limit above the hush cap", () => {
    expect(
      reduceHush({
        command: argv("/usr/bin/git", ["status"]),
        capture: report(""),
        maxReducedBytes: MAX_HUSH_REDUCED_BYTES + 1,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "hush", code: "invalid-request", reason: "invalid-reduced-limit" },
    });
  });

  test("rejects an empty important pattern without exposing the command", () => {
    expect(
      reduceHush({
        command: argv("/usr/bin/git", ["status"]),
        capture: report("ok"),
        importantPatterns: [""],
      }),
    ).toEqual({
      ok: false,
      error: { kind: "hush", code: "invalid-request", reason: "invalid-pattern" },
    });
  });
});

describe("hush family selection", () => {
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

describe("hush reduction", () => {
  test("removes a successful Bun typecheck echo but preserves it on unexplained failure", () => {
    const command = argv("/usr/bin/bun", ["run", "typecheck"]);
    const successful = reduceHush({
      command,
      capture: report("", { stderr: "$ tsc --noEmit\n" }),
    });
    expect(successful.ok).toBe(true);
    if (!successful.ok) {
      throw new Error("expected a Hush result");
    }
    expect(successful.value.reducerId).toBe("bun.typecheck");
    expect(successful.value.reducedText).toBe("");

    const failed = reduceHush({
      command,
      capture: report("", { stderr: "$ tsc --noEmit\n", exitCode: 1 }),
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      throw new Error("expected a Hush result");
    }
    expect(failed.value.reducedText).toBe("stderr:\n$ tsc --noEmit\n");
  });

  test("keeps unknown and partial lint output exact", () => {
    const unknown = "opaque lint fact\nsecond fact\n";
    const exact = reduceHush({
      command: argv("/usr/bin/eslint", ["src"]),
      capture: report(unknown, { exitCode: 1 }),
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error("expected an exact Hush result");
    expect(exact.value.reducerId).toBe("js.lint");
    expect(exact.value.reducedText).toBe(unknown);

    const partial = reduceHush({
      command: argv("/usr/bin/eslint", ["src"]),
      capture: report("/workspace/src/a.ts\n  1:1 error Missing value no-undef\n", {
        truncated: true,
        artifact: true,
        exitCode: 1,
      }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected a partial Hush result");
    expect(partial.value.reducedText).toBe(
      "/workspace/src/a.ts\n  1:1 error Missing value no-undef\n",
    );
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));
  });

  test("preserves terminal facts and omits the child environment", () => {
    const captured = report("On branch main\n", { durationMs: 44, exitCode: 1 });
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["status"]),
      capture: captured,
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.command).toEqual({
      mode: "argv",
      executable: "/usr/bin/git",
      argv: ["status"],
      command: null,
      cwd: "/workspace",
    });
    expect(reduced.value.exit).toEqual({ exitCode: 1, signal: null });
    expect(reduced.value.durationMs).toBe(duration(44));
    expect(reduced.value.stop).toEqual({ kind: "exited" });
    expect(reduced.value.reducerVersion).toBe(HUSH_REDUCER_VERSION);
    expect(reduced.value.family).toBe("git");
    expect(JSON.stringify(reduced.value)).not.toContain("do-not-copy");
  });

  test("groups rg matches by path without sampling any match", () => {
    const lines = [
      "src/a.ts:1:one",
      "src/a.ts:2:two",
      "src/a.ts:3:three",
      "src/a.ts:4:four",
      "src/a.ts:5:five",
      "src/a.ts:6:six",
      "src/a.ts:7:seven",
      "src/a.ts:8:eight",
      "src/a.ts:9:nine",
      "src/b.ts:1:keep",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/opt/homebrew/bin/rg", ["reduceHush"]),
      capture: report(lines, { artifact: true }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("search");
    expect(reduced.value.reducerId).toBe("files.rg");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toContain("  8 eight");
    expect(reduced.value.reducedText).toContain("  9 nine");
    expect(reduced.value.reducedText).toContain("src/b.ts:\n  1 keep");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
  });

  test("falls back to generic when the selected family is not expected", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/git", ["status"]),
      capture: report("M src/hush.ts\n".repeat(40)),
      expectedFamilies: ["search"],
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("git");
    expect(reduced.value.strategy).toBe("generic");
    expect(reduced.value.fallbackReason).toBe("expected-family-miss");
    expect(reduced.value.fidelity).toBe("deterministic-reduction");
  });

  test("passthrough of small utf-8 output is exact", () => {
    const reduced = reduceHush({
      command: argv("/bin/echo", ["hi"]),
      capture: report("hi\n"),
      strategy: "passthrough",
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.fidelity).toBe("exact");
    expect(reduced.value.reducedText).toBe("hi\n");
    expect(reduced.value.strategy).toBe("passthrough");
    expect(reduced.value.reducerId).toBe("safe.passthrough");
  });

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

  test("external diff removes only validated context while retaining every changed line", () => {
    const diff = [
      "--- before.ts\t2026-08-23 06:16:58",
      "+++ after.ts\t2026-08-23 06:16:58",
      "@@ -1,3 +1,3 @@",
      " export function mode() {",
      '-  return "sample";',
      '+  return "complete";',
      " }",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/diff", ["-u", "before.ts", "after.ts"]),
      capture: report(diff, { exitCode: 1 }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.diff");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.fidelity).toBe("deterministic-reduction");
    expect(reduced.value.reducedText).toBe(
      [
        "before.ts -> after.ts",
        "@@ -1,3 +1,3 @@",
        '-  return "sample";',
        '+  return "complete";',
      ].join("\n"),
    );
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.exit.exitCode).toBe(1);
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

  test("unknown commands use the generic reducer and keep stderr", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/mystery"),
      capture: report("aaaa\naaaa\naaaa\naaaa\n", { stderr: "warn\n" }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("generic");
    expect(reduced.value.fallbackReason).toBe("unknown-family");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.reducedText).toContain("aaaa ×4");
    expect(reduced.value.reducedText).toContain("stderr:\nwarn");
  });

  test("keeps every unique semantic line beyond the former default budget", () => {
    const lines = Array.from(
      { length: 600 },
      (_, index) => `case-${index.toString().padStart(3, "0")}: unique diagnostic context`,
    );
    const reduced = reduceHush({
      command: argv("/usr/bin/bun", ["test"]),
      capture: report(`${lines.join("\n")}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain(lines[0] ?? "missing-first-line");
    expect(reduced.value.reducedText).toContain(lines.at(-1) ?? "missing-last-line");
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("counts repeated progress lines instead of silently dropping them", () => {
    const output = `${"Compiling falryn\n".repeat(80)}Finished release build\n`;
    const reduced = reduceHush({
      command: argv("/usr/bin/tail", ["-n", "100", "build.log"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.tail");
    expect(reduced.value.reducedText).toContain("Compiling falryn ×80");
    expect(reduced.value.reducedText).toContain("Finished release build");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("journalctl shares stable fields while retaining every event fact", () => {
    const output = [
      "Aug 24 10:00:00 falryn-host falryn[736]: INFO session started session=demo",
      "Aug 24 10:00:01 falryn-host falryn[736]: INFO context engine ready reducers=82",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:03 falryn-host falryn[736]: WARN reducer fallback command=unknown",
      "Aug 24 10:00:04 falryn-host falryn[736]: ERROR capture unavailable id=cap-42",
      "Aug 24 10:00:05 falryn-host falryn[736]: INFO request complete tokens=219",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/journalctl", ["-u", "falryn", "-n", "20"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("transform.log");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toContain("Aug 24 10:00 falryn-host falryn[736]");
    expect(reduced.value.reducedText).toContain("00 [I] session started session=demo");
    expect(reduced.value.reducedText).toContain("02 [I] waiting for provider ×3");
    expect(reduced.value.reducedText).toContain("03 [W] reducer fallback command=unknown");
    expect(reduced.value.reducedText).toContain("04 [E] capture unavailable id=cap-42");
    expect(reduced.value.reducedText).toContain("05 [I] request complete tokens=219");
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeLessThan(
      encoder.encode(output).byteLength,
    );
  });

  test("journal log projection keeps an unrecognized tail exact", () => {
    const output = "function example() {\n  return 736;\n}\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/tail", ["-n", "3", "src/example.ts"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.tail");
    expect(reduced.value.reducedText).toBe(output);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("wc removes only redundant single-file presentation", () => {
    const output = "     127     384    3268 src/domain/hush/reducers/log/format.ts\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/wc", ["-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.count");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toBe("127 384 3268\n");
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("wc retains every multi-file count and exact total", () => {
    const output = [
      "     127     384    3268 src/domain/hush/reducers/log/format.ts",
      "      32     131    1251 src/domain/hush/reducers/log/projection.ts",
      "     159     515    4519 total",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/wc", [
        "src/domain/hush/reducers/log/format.ts",
        "src/domain/hush/reducers/log/projection.ts",
      ]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(
      ["127L 384W 3268B format.ts", "32L 131W 1251B projection.ts", "Σ 159L 515W 4519B", ""].join(
        "\n",
      ),
    );
    expect(reduced.value.omissions).toEqual([]);
  });

  test("wc keeps failures exact instead of inventing counts", () => {
    const output = "wc: missing.ts: open: No such file or directory\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/wc", ["-l", "missing.ts"]),
      capture: report("", { stderr: output, exitCode: 1 }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(`stderr:\n${output}`);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("psql retains every cell while removing validated table presentation", () => {
    const output = [
      " id | task                   | status  | token_savings",
      "----+------------------------+---------+--------------",
      "  1 | Optimize nested JSON   | done    |            32",
      "  2 | Preserve database rows | active  |             0",
      "  3 | Verify model context   | pending |            18",
      "(3 rows)",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/opt/homebrew/bin/psql", ["-c", "select * from work_items"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.command");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toBe(
      [
        "id\ttask\tstatus\ttoken_savings",
        "1\tOptimize nested JSON\tdone\t32",
        "2\tPreserve database rows\tactive\t0",
        "3\tVerify model context\tpending\t18",
        "",
      ].join("\n"),
    );
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("psql keeps failures and malformed result shapes exact", () => {
    const malformed = " id | task\n----+-----\n  1 | one\n(2 rows)\n";
    const malformedResult = reduceHush({
      command: argv("psql", ["-c", "select * from work_items"]),
      capture: report(malformed),
    });
    expect(malformedResult.ok).toBe(true);
    if (!malformedResult.ok) {
      throw new Error("expected a hush result");
    }
    expect(malformedResult.value.reducedText).toBe(malformed);
    expect(malformedResult.value.strategy).toBe("passthrough");

    const failure = "psql: error: connection to server failed\n";
    const failedResult = reduceHush({
      command: argv("psql", ["-c", "select 1"]),
      capture: report("", { stderr: failure, exitCode: 2 }),
    });
    expect(failedResult.ok).toBe(true);
    if (!failedResult.ok) {
      throw new Error("expected a hush result");
    }
    expect(failedResult.value.reducedText).toBe(`stderr:\n${failure}`);
    expect(failedResult.value.omissions).toEqual([]);
  });

  test("sqlite3 retains every cell while removing validated table presentation", () => {
    const output = [
      "id  task           status",
      "--  -------------  ------",
      "1   Optimize JSON  done  ",
      "2   Preserve rows  active",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/sqlite3", ["-header", "-column", ":memory:", "select 1"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.command");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toBe(
      "id\ttask\tstatus\n1\tOptimize JSON\tdone\n2\tPreserve rows\tactive\n",
    );
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("sqlite3 keeps compact modes, malformed shapes, and failures exact", () => {
    const list = "id|task\n1|Optimize JSON\n";
    const listed = reduceHush({
      command: argv("sqlite3", ["-header", "-list", ":memory:", "select 1"]),
      capture: report(list),
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error("expected a hush result");
    }
    expect(listed.value.reducedText).toBe(list);

    const malformed = "id  task\n--  ----\n1   one\n2 unexpected\n";
    const malformedResult = reduceHush({
      command: argv("sqlite3", ["-header", "-column", ":memory:", "select 1"]),
      capture: report(malformed),
    });
    expect(malformedResult.ok).toBe(true);
    if (!malformedResult.ok) {
      throw new Error("expected a hush result");
    }
    expect(malformedResult.value.reducedText).toBe(malformed);
    expect(malformedResult.value.strategy).toBe("passthrough");

    const failure = "Error: in prepare, no such table: missing\n";
    const failed = reduceHush({
      command: argv("sqlite3", [":memory:", "select * from missing"]),
      capture: report("", { stderr: failure, exitCode: 1 }),
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      throw new Error("expected a hush result");
    }
    expect(failed.value.reducedText).toBe(`stderr:\n${failure}`);
    expect(failed.value.omissions).toEqual([]);
  });

  test("sqlite3 keeps requested-pattern output exact instead of presentation-compacting it", () => {
    const output = [
      "id  task           status",
      "--  -------------  ------",
      "1   Optimize JSON  done  ",
      "2   Preserve rows  active",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("sqlite3", ["-header", "-column", ":memory:", "select 1"]),
      capture: report(output),
      importantPatterns: ["active"],
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(output);
    expect(reduced.value.strategy).toBe("passthrough");
  });

  test("minifies structured JSON without changing its values", () => {
    const document = {
      account: "falryn",
      enabled: true,
      nested: { message: "spaces inside strings stay intact", values: [1, 2, 3] },
    };
    const reduced = reduceHush({
      command: argv("/usr/bin/jq", [".", "fixture.json"]),
      capture: report(`${JSON.stringify(document, null, 2)}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.command");
    expect(JSON.parse(reduced.value.reducedText)).toEqual(document);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("projects the JSON helper as a complete key/type structure without values", () => {
    const manyFields = Object.fromEntries(
      Array.from({ length: 480 }, (_, index) => [
        `field-${index.toString().padStart(3, "0")}`,
        `private-${index}-`.repeat(6),
      ]),
    );
    const document = {
      serviceName: "falryn-private-value".repeat(8),
      enabled: true,
      targets: [
        { os: "darwin-private", arch: "arm64-private" },
        { os: "linux-private", arch: "x64-private" },
      ],
      metadata: { owner: "owner-private", nested: { marker: "deep-private" } },
      ports: [3000, 3001, 3002],
      manyFields,
    };
    const reduced = reduceHush({
      command: argv("/usr/bin/json", ["config.json"]),
      capture: report(`${JSON.stringify(document, null, 2)}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.json");
    expect(reduced.value.reducedText).toContain("serviceName string");
    expect(reduced.value.reducedText).toContain("enabled boolean");
    expect(reduced.value.reducedText).toContain("targets[2]:");
    expect(reduced.value.reducedText).toContain("arch string");
    expect(reduced.value.reducedText).toContain("ports integer[3]");
    expect(reduced.value.reducedText).toContain("field-000 string");
    expect(reduced.value.reducedText).toContain("field-479 string");
    expect(reduced.value.reducedText).not.toContain("falryn-private-value");
    expect(reduced.value.reducedText).not.toContain("darwin-private");
    expect(reduced.value.reducedText).not.toContain("3000");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeGreaterThan(
      DEFAULT_HUSH_REDUCED_BYTES,
    );
  });

  test("keeps every curl JSON value while stripping only the transfer meter", () => {
    const body = {
      status: "ok",
      requestId: "req-736",
      result: { reducers: 81, complete: true },
    };
    const progress = [
      "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
      "                                 Dload  Upload   Total   Spent    Left  Speed",
      "100   102  100   102    0     0   1020      0 --:--:-- --:--:-- --:--:--  1020",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/curl", ["https://example.test/status"]),
      capture: report(`${JSON.stringify(body, null, 2)}\n`, { stderr: `${progress}\n` }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("network.curl");
    expect(JSON.parse(reduced.value.reducedText)).toEqual(body);
    expect(reduced.value.reducedText).not.toContain("% Total");
    expect(reduced.value.reducedText).not.toContain("1020");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("retains long curl text beyond the generic budget without line sampling", () => {
    const lines = Array.from(
      { length: 600 },
      (_, index) => `response-row-${index.toString().padStart(3, "0")} complete server context`,
    );
    const reduced = reduceHush({
      command: argv("/usr/bin/curl", ["https://example.test/long"]),
      capture: report(`${lines.join("\n")}\n`, {
        stderr: "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n",
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain(lines[0] ?? "missing-first");
    expect(reduced.value.reducedText).toContain(lines.at(-1) ?? "missing-last");
    expect(reduced.value.reducedText).not.toContain("% Total");
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeGreaterThan(
      DEFAULT_HUSH_REDUCED_BYTES,
    );
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("summarizes a wget download without losing its result facts", () => {
    const stderr = [
      "--2026-08-23 12:00:00--  https://example.test/releases/falryn.tar.gz",
      "Resolving example.test... 192.0.2.80",
      "Connecting to example.test|192.0.2.80|:443... connected.",
      "HTTP request sent, awaiting response... 200 OK",
      "Length: 1536 (1.5K) [application/gzip]",
      "Saving to: 'falryn.tar.gz'",
      "     0K .                                                     100% 1.50M=0.001s",
      "2026-08-23 12:00:00 (1.50 MB/s) - 'falryn.tar.gz' saved [1536/1536]",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["https://example.test/releases/falryn.tar.gz"]),
      capture: report("", { stderr: `${stderr}\n` }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("network.wget");
    expect(reduced.value.reducedText).toBe(
      "200 example.test/releases/falryn.tar.gz -> falryn.tar.gz 1.5KB",
    );
    expect(reduced.value.omissions).toEqual([]);
  });

  test("retains every wget stdout line instead of applying RTK's line sample", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `body-line-${index}`);
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["-O", "-", "https://example.test/data.txt"]),
      capture: report(`${lines.join("\n")}\n`, {
        stderr: "     0K .......... 100% 1.50M=0.001s\n",
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain(lines[0] ?? "missing-first");
    expect(reduced.value.reducedText).toContain(lines.at(-1) ?? "missing-last");
    expect(reduced.value.reducedText).not.toContain("100%");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("retains wget failures while removing only their transfer meter", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["https://example.test/missing"]),
      capture: report("", {
        stderr: [
          "HTTP request sent, awaiting response... 404 Not Found",
          "     0K .......... 100% 1.50M=0.001s",
          "ERROR 404: Not Found.",
          "",
        ].join("\n"),
        exitCode: 8,
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("404 Not Found");
    expect(reduced.value.reducedText).toContain("ERROR 404: Not Found.");
    expect(reduced.value.reducedText).not.toContain("100%");
    expect(reduced.value.exit.exitCode).toBe(8);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps a wget redirect chain instead of collapsing multiple responses", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["https://example.test/latest"]),
      capture: report("", {
        stderr: [
          "HTTP request sent, awaiting response... 302 Found",
          "Location: https://cdn.example.test/falryn.tar.gz [following]",
          "HTTP request sent, awaiting response... 200 OK",
          "Length: 1536 (1.5K) [application/gzip]",
          "Saving to: 'falryn.tar.gz'",
          "     0K .......... 100% 1.50M=0.001s",
          "",
        ].join("\n"),
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("302 Found");
    expect(reduced.value.reducedText).toContain(
      "Location: https://cdn.example.test/falryn.tar.gz [following]",
    );
    expect(reduced.value.reducedText).toContain("200 OK");
    expect(reduced.value.reducedText).not.toContain("100%");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("makes find paths relative without sampling any entry", () => {
    const paths = ["corpus/docs/README.md", "corpus/src/main.ts", "corpus/src/domain/hush.ts"];
    const reduced = reduceHush({
      command: argv("/usr/bin/find", ["corpus", "-type", "f"]),
      capture: report(`${paths.join("\n")}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.find");
    expect(reduced.value.reducedText).toBe("docs/README.md\nsrc/main.ts\nsrc/domain/hush.ts");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("normalizes aligned tables while retaining every cell", () => {
    const table = [
      "CONTAINER ID   IMAGE          STATUS          NAMES",
      "abc123         falryn:dev     Up 2 minutes    falryn-dev",
      "def456         postgres:17    Up 2 minutes    falryn-db",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/docker", ["ps"]),
      capture: report(`${table}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("container.table");
    expect(reduced.value.reducedText).toContain("ID\tIMAGE\tSTATUS\tNAME");
    expect(reduced.value.reducedText).toContain("abc123\tfalryn:dev\tUp 2 minutes\tfalryn-dev");
    expect(reduced.value.reducedText).toContain("def456\tpostgres:17\tUp 2 minutes\tfalryn-db");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("compacts complete system command results without dropping decision facts", () => {
    const cases = [
      {
        executable: "df",
        argv: ["-h", "."],
        output: [
          "Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on",
          "/dev/disk3s5   460Gi   147Gi   290Gi    34%    1.7M  3.0G    0%   /System/Volumes/Data",
          "",
        ].join("\n"),
        markers: ["filesystem\tsize\tused", "/System/Volumes/Data"],
      },
      {
        executable: "du",
        argv: ["-sh", "."],
        output: "319M\t.\n",
        markers: ["319M\t."],
      },
      {
        executable: "ps",
        argv: ["-p", "49114", "-o", "pid,ppid,state,comm"],
        output: "  PID  PPID STAT COMM\n49114 41183 Ss   bun\n",
        markers: ["PID\tPPID\tSTAT\tCOMM", "49114\t41183\tSs\tbun"],
      },
      {
        executable: "stat",
        argv: ["-x", "package.json"],
        output: [
          '  File: "package.json"',
          "  Size: 2527         FileType: Regular File",
          "  Mode: (0644/-rw-r--r--)         Uid: (  501/yogeshprasad)  Gid: (   20/   staff)",
          "Device: 1,15   Inode: 32125206    Links: 1",
          "Access: Mon Aug 24 01:55:42 2026",
          "Modify: Sun Aug 23 05:26:48 2026",
          "Change: Sun Aug 23 05:26:48 2026",
          " Birth: Fri Aug 21 19:55:14 2026",
          "",
        ].join("\n"),
        markers: ["dev=1,15 inode=32125206 links=1", "birth=Fri Aug 21 19:55:14"],
      },
      {
        executable: "systemctl",
        argv: ["status", "falryn"],
        output: [
          "● falryn.service - Falryn agent",
          "     Loaded: loaded (/etc/systemd/system/falryn.service; enabled; preset: enabled)",
          "     Active: active (running) since Mon 2026-08-24 10:00:00 PDT; 2h 30min ago",
          "   Main PID: 736 (falryn)",
          "      Tasks: 8 (limit: 1024)",
          "     Memory: 42.0M",
          "        CPU: 1.234s",
          "     CGroup: /system.slice/falryn.service",
          "             └─736 /usr/local/bin/falryn",
          "",
        ].join("\n"),
        markers: ["Active: active (running)", "Main PID: 736", "└─736 /usr/local/bin/falryn"],
      },
    ] as const;

    for (const fixture of cases) {
      const reduced = reduceHush({
        command: argv(`/usr/bin/${fixture.executable}`, fixture.argv),
        capture: report(fixture.output),
      });
      expect(reduced.ok).toBe(true);
      if (!reduced.ok) {
        throw new Error(`expected a ${fixture.executable} Hush result`);
      }
      expect(reduced.value.reducerId).toBe("system.table");
      expect(reduced.value.omissions).toEqual([]);
      expect(reduced.value.truncated).toBe(false);
      expect(new TextEncoder().encode(reduced.value.reducedText).byteLength).toBeLessThanOrEqual(
        new TextEncoder().encode(fixture.output).byteLength,
      );
      for (const marker of fixture.markers) {
        expect(reduced.value.reducedText).toContain(marker);
      }
    }
  });

  test("keeps failed, ambiguous, and caller-pattern system output exact", () => {
    const ambiguous = "STARTED PID\nMon Aug 24 10:00:00 736\n";
    const ps = reduceHush({
      command: argv("/bin/ps", ["-o", "lstart,pid"]),
      capture: report(ambiguous),
    });
    expect(ps.ok).toBe(true);
    if (!ps.ok) {
      throw new Error("expected a ps Hush result");
    }
    expect(ps.value.reducedText).toBe(ambiguous);
    expect(ps.value.strategy).toBe("passthrough");

    const failure = "stat: missing: stat: No such file or directory\n";
    const stat = reduceHush({
      command: argv("/usr/bin/stat", ["missing"]),
      capture: report("", { stderr: failure, exitCode: 1 }),
    });
    expect(stat.ok).toBe(true);
    if (!stat.ok) {
      throw new Error("expected a stat Hush result");
    }
    expect(stat.value.reducedText).toBe(`stderr:\n${failure}`);
    expect(stat.value.omissions).toEqual([]);

    const df = "Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 100G 40G 60G 40% /\n";
    const patterned = reduceHush({
      command: argv("/bin/df", ["-h", "."]),
      capture: report(df),
      importantPatterns: ["/dev/sda1"],
    });
    expect(patterned.ok).toBe(true);
    if (!patterned.ok) {
      throw new Error("expected a df Hush result");
    }
    expect(patterned.value.reducedText).toBe(df);
  });

  test("renders AWS caller identity in a compact model-readable form", () => {
    const identity = {
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/falryn",
      UserId: "AIDAEXAMPLE",
    };
    const reduced = reduceHush({
      command: argv("/usr/bin/aws", ["sts", "get-caller-identity"]),
      capture: report(`${JSON.stringify(identity, null, 2)}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("cloud.aws");
    expect(reduced.value.reducedText).toBe(
      "AWS iam account=123456789012 user=falryn id=AIDAEXAMPLE\n",
    );
    expect(reduced.value.omissions).toEqual([]);
  });

  test("summarizes successful tests without a fixed test-count cap", () => {
    const output = [
      "tests/test_hush.py::test_complete PASSED",
      "tests/test_hush.py::test_budget PASSED",
      "2 passed in 0.12s",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/pytest"),
      capture: report(`${output}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("python.test");
    expect(reduced.value.reducedText).toBe("2 passed 0.12s");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps unknown and partial test output exact", () => {
    const unknown = "opaque runner fact\nsecond fact\n";
    const exact = reduceHush({
      command: argv("/usr/bin/pytest"),
      capture: report(unknown),
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error("expected an exact Hush result");
    expect(exact.value.reducedText).toBe(unknown);

    const partial = reduceHush({
      command: argv("/usr/bin/pytest"),
      capture: report("test_complete PASSED\n", { truncated: true, artifact: true }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected a partial Hush result");
    expect(partial.value.reducedText).toBe("test_complete PASSED\n");
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));
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

  test("binary stdout is omitted with an expansion route", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/cat", ["blob"]),
      capture: report("\u0000\u0001", { encoding: "binary", artifact: true }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).not.toContain("\u0000");
    expect(reduced.value.omissions).toContainEqual({
      kind: "binary-stream",
      stream: "stdout",
      count: 2,
      detail: "cap-1.stdout",
    });
    expect(reduced.value.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
  });

  test("timed-out capture facts survive reduction", () => {
    const reduced = reduceHush({
      command: argv("/bin/sleep", ["5"]),
      capture: report("", {
        stop: { kind: "timed-out", timeoutMs: duration(200) },
        exitCode: null,
        durationMs: 200,
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.stop).toEqual({ kind: "timed-out", timeoutMs: duration(200) });
    expect(reduced.value.exit.exitCode).toBeNull();
  });

  test("keeps every entry when an important pattern is requested", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `file-${index}.ts`).join("\n");
    const reduced = reduceHush({
      command: argv("/bin/ls"),
      capture: report(`${lines}\nkeep-me.ts\n`),
      importantPatterns: ["keep-me.ts"],
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("listing");
    expect(reduced.value.reducedText).toContain("keep-me.ts");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("compacts long ls metadata without dropping an entry", () => {
    const lines = Array.from(
      { length: 80 },
      (_, index) =>
        `-rw-r--r--  1 user  staff  128 Aug 23 12:00 module-${String(index).padStart(2, "0")}.ts`,
    );
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-lahiF", "workspace"]),
      capture: report(`${lines.join("\n")}\n`, { artifact: true }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.ls");
    expect(reduced.value.reducedText).toStartWith("files 644 (80):\n");
    for (let index = 0; index < 80; index += 1) {
      expect(reduced.value.reducedText).toContain(
        `module-${String(index).padStart(2, "0")}.ts 128B`,
      );
    }
    expect(reduced.value.reducedText).not.toContain("user  staff");
    expect(reduced.value.reducedText).not.toContain("Aug 23 12:00");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeLessThan(
      encoder.encode(lines.join("\n")).byteLength,
    );
    expect(reduced.value.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
  });

  test("passes through a small ls result exactly", () => {
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-1", "workspace"]),
      capture: report("README.md\npackage.json\n"),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.strategy).toBe("passthrough");
    expect(reduced.value.fidelity).toBe("exact");
    expect(reduced.value.reducedText).toBe("README.md\npackage.json\n");
  });

  test("keeps recursive ls output exact instead of sampling sections", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `file-${index}.ts`);
    lines[0] = "workspace:";
    lines[20] = "workspace/src:";
    lines[40] = "workspace/tests:";
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-R", "workspace"]),
      capture: report(`${lines.join("\n")}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("workspace:");
    expect(reduced.value.reducedText).toContain("workspace/src:");
    expect(reduced.value.reducedText).toContain("workspace/tests:");
    expect(reduced.value.reducedText).toBe(`${lines.join("\n")}\n`);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps efficient single-line ls formats exact", () => {
    const line = Array.from({ length: 120 }, (_, index) => `file ${index}.ts`).join(", ");
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-m", "workspace"]),
      capture: report(`${line}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.ls");
    expect(reduced.value.strategy).toBe("passthrough");
    expect(reduced.value.fidelity).toBe("exact");
    expect(reduced.value.reducedText).toBe(`${line}\n`);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("does not impose the generic default byte cap on ls", () => {
    const output = `${Array.from(
      { length: 1_000 },
      (_, index) => `long-filename-${String(index).padStart(4, "0")}.ts`,
    ).join("\n")}\n`;
    expect(encoder.encode(output).byteLength).toBeGreaterThan(DEFAULT_HUSH_REDUCED_BYTES);

    const reduced = reduceHush({
      command: argv("/bin/ls", ["-1", "workspace"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(output);
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("preserves complete tree structure instead of applying the generic line cap", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `|-- file-${index}.ts`);
    const output = ["workspace", ...lines, "", "0 directories, 40 files", ""].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/tree", ["workspace"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.tree");
    expect(reduced.value.reducedText).toContain("file-39.ts");
    expect(reduced.value.reducedText).not.toContain("directories");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("does not impose the generic default byte cap on tree", () => {
    const lines = Array.from(
      { length: 1_000 },
      (_, index) => `|-- long-tree-entry-${String(index).padStart(4, "0")}.ts`,
    );
    const output = ["workspace", ...lines, "", "0 directories, 1000 files", ""].join("\n");
    expect(encoder.encode(output).byteLength).toBeGreaterThan(DEFAULT_HUSH_REDUCED_BYTES);

    const reduced = reduceHush({
      command: argv("/usr/bin/tree", ["workspace"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("long-tree-entry-0999.ts");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeGreaterThan(
      DEFAULT_HUSH_REDUCED_BYTES,
    );
  });

  test("createHushPort exposes the same reduce function", () => {
    const port = createHushPort();
    const reduced = port.reduce({
      command: argv("/usr/bin/true"),
      capture: report(""),
    });
    expect(reduced.ok).toBe(true);
  });
});
