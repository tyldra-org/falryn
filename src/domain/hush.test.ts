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

  test("git diff compacts file headers while retaining every hunk line", () => {
    const diff = [
      "diff --git a/src/hush.ts b/src/hush.ts",
      "--- a/src/hush.ts",
      "+++ b/src/hush.ts",
      "@@ -1,4 +1,5 @@",
      "-old",
      "-also",
      "+new",
      "+newer",
      "+newest",
      "diff --git a/src/other.ts b/src/other.ts",
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
    expect(reduced.value.reducedText).toContain("@@ -1,4 +1,5 @@");
    expect(reduced.value.reducedText).toContain("-also");
    expect(reduced.value.reducedText).toContain("+newest");
    expect(reduced.value.omissions).toEqual([]);
    expect(new TextEncoder().encode(reduced.value.reducedText).byteLength).toBeLessThan(
      new TextEncoder().encode(diff).byteLength,
    );
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
    expect(reduced.value.reducedText).toBe("2 passed 0.12s\n");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("removes Git push progress from stderr but retains its destination and ref", () => {
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
    expect(reduced.value.reducedText).not.toContain("Enumerating objects");
    expect(reduced.value.reducedText).not.toContain("Writing objects");
    expect(reduced.value.reducedText).toContain("github.com:yogeshprasad098/falryn.git");
    expect(reduced.value.reducedText).toContain("1111111..2222222  feature -> feature");
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
