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

  test("groups rg matches by path and keeps an expansion artifact", () => {
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
    expect(reduced.value.reducedText).toContain("src/a.ts:8:eight");
    expect(reduced.value.reducedText).not.toContain("src/a.ts:9:nine");
    expect(reduced.value.reducedText).toContain("src/b.ts:1:keep");
    expect(reduced.value.omissions.some((omission) => omission.kind === "capped-lines")).toBe(true);
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

  test("git diff keeps per-file stats and drops hunk bodies", () => {
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
    expect(reduced.value.reducedText).toContain("src/hush.ts: +3 -2");
    expect(reduced.value.reducedText).toContain("src/other.ts: +1 -1");
    expect(reduced.value.reducedText).not.toContain("@@");
    expect(new TextEncoder().encode(reduced.value.reducedText).byteLength).toBeLessThan(
      new TextEncoder().encode(diff).byteLength,
    );
  });

  test("git status groups porcelain paths and omits extra files per directory", () => {
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
    expect(reduced.value.reducedText).toContain("## main");
    expect(
      reduced.value.reducedText.split("\n").filter((line) => line.includes("src/hush/file")).length,
    ).toBe(8);
    expect(
      reduced.value.omissions.some(
        (omission) => omission.kind === "capped-lines" && omission.count === 2,
      ),
    ).toBe(true);
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
    expect(reduced.value.omissions.some((omission) => omission.kind === "duplicate-run")).toBe(
      true,
    );
    expect(reduced.value.reducedText).toContain("stderr:\nwarn");
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

  test("keeps an important pattern when listing output is capped", () => {
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
