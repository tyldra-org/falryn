/**
 * Hush observation across shell, Git, test, search, and process origins.
 */

import { describe, expect, test } from "bun:test";

import {
  artifactId,
  duration,
  instant,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_HUSH_REDUCED_BYTES,
  type ProcessCaptureError,
  type ProcessCapturePort,
  type ProcessCaptureReport,
  type ProcessCaptureRequest,
  processCaptureId,
  workspaceId,
} from "../domain/index.ts";
import { createHushIntegrator, expectedFamiliesForOrigin } from "./hush.ts";
import { REDACTED } from "./redaction.ts";

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

function capturePort(
  outcome: ProcessCaptureReport | ProcessCaptureError,
): ProcessCapturePort & { readonly requests: () => readonly ProcessCaptureRequest[] } {
  const requests: ProcessCaptureRequest[] = [];
  return {
    requests: () => requests,
    async run(request) {
      requests.push(request);
      if ("captureId" in outcome) {
        return { ok: true, value: outcome };
      }
      return { ok: false, error: outcome };
    },
  };
}

const gitDiff = [
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

const rgLines = [
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

const bunTest = [
  "bun test v1.2.0",
  ...Array.from({ length: 20 }, (_, index) => `ok src/hush.test.ts > case ${index}`),
  "(pass) src/hush.test.ts",
  " 20 pass",
  " 0 fail",
].join("\n");

describe("createHushIntegrator", () => {
  test("maps origins onto expected hush families", () => {
    expect(expectedFamiliesForOrigin("shell")).toEqual(["listing", "search", "generic"]);
    expect(expectedFamiliesForOrigin("git")).toEqual(["git"]);
    expect(expectedFamiliesForOrigin("test")).toEqual(["test", "lint", "typecheck", "build"]);
    expect(expectedFamiliesForOrigin("search")).toEqual(["search"]);
    expect(expectedFamiliesForOrigin("process")).toBeUndefined();
  });

  test("rejects an unknown origin without capturing", async () => {
    const capture = capturePort(report("ok\n"));
    const integrator = createHushIntegrator({ capture });
    const observed = await integrator.observe({
      origin: "pty",
      command: argv("/bin/ls"),
    });
    expect(observed).toEqual({
      ok: false,
      error: { kind: "hush-observation", code: "invalid-origin", field: "origin" },
    });
    expect(capture.requests()).toEqual([]);
  });

  test("observe without a capture port is unavailable", async () => {
    const integrator = createHushIntegrator();
    const observed = await integrator.observe({
      origin: "process",
      command: argv("/bin/echo", ["hi"]),
    });
    expect(observed).toEqual({
      ok: false,
      error: { kind: "hush-observation", code: "unavailable", field: "capture" },
    });
  });

  test("observe keeps the capture report object and omits the child environment", async () => {
    const captured = report("hi\n");
    const capture = capturePort(captured);
    const integrator = createHushIntegrator({ capture });
    const command = argv("/bin/echo", ["hi"]);
    const observed = await integrator.observe({
      origin: "process",
      command,
      strategy: "passthrough",
    });
    expect(observed.ok).toBe(true);
    if (!observed.ok) {
      return;
    }
    expect(observed.value.capture).toBe(captured);
    expect(observed.value.hush.exit).toEqual(captured.exit);
    expect(observed.value.hush.stop).toEqual(captured.stop);
    expect(observed.value.hush.durationMs).toBe(captured.durationMs);
    expect(observed.value.hush.command).toEqual({
      mode: "argv",
      executable: "/bin/echo",
      argv: ["hi"],
      command: null,
      cwd: "/workspace",
    });
    expect("command" in observed.value).toBe(false);
    expect(JSON.stringify(observed.value.hush)).not.toContain("do-not-copy");
    expect(JSON.stringify(observed.value)).not.toContain("do-not-copy");
    expect(capture.requests()).toEqual([command]);
  });

  test("reduce hushes git diff without rewriting terminal facts", () => {
    const captured = report(gitDiff, { exitCode: 0, durationMs: 44 });
    const integrator = createHushIntegrator();
    const reduced = integrator.reduce({
      origin: "git",
      command: argv("/usr/bin/git", ["diff"]),
      capture: captured,
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.origin).toBe("git");
    expect(reduced.value.capture).toBe(captured);
    expect(reduced.value.capture.stdout.inlineText).toBe(gitDiff);
    expect(reduced.value.hush.family).toBe("git");
    expect(reduced.value.hush.reducerId).toBe("git.diff");
    expect(reduced.value.hush.reducedText).toContain("src/hush.ts:");
    expect(reduced.value.hush.reducedText).toContain("@@ -1,4 +1,5 @@");
    expect(reduced.value.hush.reducedText).toContain("-also");
    expect(reduced.value.hush.reducedText).toContain("+newest");
    expect(reduced.value.projection).toBe(reduced.value.hush.reducedText);
  });

  test("shell listings keep every path without a listing cap", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `file-${index}.ts`).join("\n");
    const captured = report(`${lines}\nkeep-me.ts\n`);
    const integrator = createHushIntegrator();
    const reduced = integrator.reduce({
      origin: "shell",
      command: bash("ls"),
      capture: captured,
      importantPatterns: ["keep-me.ts"],
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.hush.family).toBe("listing");
    expect(reduced.value.projection).toContain("keep-me.ts");
    expect(reduced.value.projection).toContain("file-39.ts");
    expect(reduced.value.hush.omissions).toEqual([]);
    expect(reduced.value.hush.command.mode).toBe("bash");
    expect(reduced.value.hush.command.command).toBe("ls");
  });

  test("test origin summarizes bun test output and keeps the capture", () => {
    const captured = report(`${bunTest}\n`, { stderr: "warn\n" });
    const integrator = createHushIntegrator();
    const reduced = integrator.reduce({
      origin: "test",
      command: argv("/usr/bin/bun", ["test", "src"]),
      capture: captured,
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.hush.family).toBe("test");
    expect(reduced.value.projection).toContain("20 pass");
    expect(reduced.value.capture.stderr.inlineText).toBe("warn\n");
  });

  test("search origin groups rg matches and keeps expansion handles", () => {
    const captured = report(rgLines, { artifact: true });
    const integrator = createHushIntegrator();
    const reduced = integrator.reduce({
      origin: "search",
      command: argv("/opt/homebrew/bin/rg", ["reduceHush"]),
      capture: captured,
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.hush.family).toBe("search");
    expect(reduced.value.hush.reducerId).toBe("files.rg");
    expect(reduced.value.projection).toContain("src/a.ts:");
    expect(reduced.value.projection).toContain("  8 eight");
    expect(reduced.value.projection).toContain("  9 nine");
    expect(reduced.value.hush.omissions).toEqual([]);
    expect(reduced.value.hush.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
    expect(reduced.value.capture.stdout.artifact?.artifactId).toEqual(
      artifactId.from("cap-1.stdout"),
    );
  });

  test("git on a search origin falls back without rewriting capture text", () => {
    const captured = report("M src/hush.ts\n".repeat(40));
    const integrator = createHushIntegrator();
    const reduced = integrator.reduce({
      origin: "search",
      command: argv("/usr/bin/git", ["status"]),
      capture: captured,
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.hush.family).toBe("git");
    expect(reduced.value.hush.strategy).toBe("generic");
    expect(reduced.value.hush.fallbackReason).toBe("expected-family-miss");
    expect(reduced.value.capture.stdout.inlineText).toBe(captured.stdout.inlineText);
  });

  test("cancelled and timed-out stops survive as facts", () => {
    const integrator = createHushIntegrator();
    const cancelled = integrator.reduce({
      origin: "process",
      command: argv("/bin/sleep", ["5"]),
      capture: report("", { stop: { kind: "cancelled" }, exitCode: null }),
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) {
      return;
    }
    expect(cancelled.value.hush.stop).toEqual({ kind: "cancelled" });
    expect(cancelled.value.capture.stop).toEqual({ kind: "cancelled" });

    const timedOut = integrator.reduce({
      origin: "process",
      command: argv("/bin/sleep", ["5"]),
      capture: report("", {
        stop: { kind: "timed-out", timeoutMs: duration(200) },
        exitCode: null,
        durationMs: 200,
      }),
    });
    expect(timedOut.ok).toBe(true);
    if (!timedOut.ok) {
      return;
    }
    expect(timedOut.value.hush.stop).toEqual({ kind: "timed-out", timeoutMs: duration(200) });
    expect(timedOut.value.hush.exit.exitCode).toBeNull();
  });

  test("spawn failure from capture is not rewritten into a hush result", async () => {
    const integrator = createHushIntegrator({
      capture: capturePort({
        kind: "process-capture",
        code: "spawn-failed",
        detail: "ENOENT",
      }),
    });
    const observed = await integrator.observe({
      origin: "shell",
      command: argv("/usr/bin/rg", ["token"]),
    });
    expect(observed).toEqual({
      ok: false,
      error: { kind: "process-capture", code: "spawn-failed", detail: "ENOENT" },
    });
  });

  test("invalid hush limits fail before projection", () => {
    const integrator = createHushIntegrator();
    expect(
      integrator.reduce({
        origin: "process",
        command: argv("/bin/echo", ["hi"]),
        capture: report("hi\n"),
        maxReducedBytes: MAX_HUSH_REDUCED_BYTES + 1,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "hush", code: "invalid-request", reason: "invalid-reduced-limit" },
    });
  });

  test("redacts secret-shaped output in the projection and keeps capture bytes", () => {
    const stdout = "token=sk-live-SECRETVALUE\n";
    const captured = report(stdout);
    const integrator = createHushIntegrator();
    const reduced = integrator.reduce({
      origin: "process",
      command: argv("/usr/bin/mystery"),
      capture: captured,
      strategy: "passthrough",
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.capture.stdout.inlineText).toBe(stdout);
    expect(reduced.value.hush.reducedText).toContain("sk-live-SECRETVALUE");
    expect(reduced.value.projection).toContain(REDACTED);
    expect(reduced.value.projection).not.toContain("sk-live-SECRETVALUE");
    const admitted = integrator.toEvidence({
      observation: reduced.value,
      id: "ev-secret",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) {
      return;
    }
    expect(admitted.value.fidelity).toBe("deterministic-transform");
    expect(admitted.value.exactSource).toBeNull();
    expect(admitted.value.sensitivity).toBe("sensitive");
    if (admitted.value.payload.kind === "inline") {
      expect(admitted.value.payload.text).not.toContain("sk-live-SECRETVALUE");
    }
  });

  test("admits exact passthrough as exact-source and git reduction as a transform", () => {
    const integrator = createHushIntegrator();
    const exact = integrator.reduce({
      origin: "process",
      command: argv("/bin/echo", ["hi"]),
      capture: report("hi\n"),
      strategy: "passthrough",
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) {
      return;
    }
    const admitted = integrator.toEvidence({
      observation: exact.value,
      id: "ev-echo",
      workspaceId: workspaceId.from("workspace-1"),
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) {
      return;
    }
    expect(admitted.value.sourceKind).toBe("process");
    expect(admitted.value.fidelity).toBe("exact-source");
    expect(admitted.value.lineage).toEqual([]);
    expect(admitted.value.exactSource).not.toBeNull();
    expect(admitted.value.payload).toEqual({
      kind: "inline",
      text: "hi\n",
      byteLength: encoder.encode("hi\n").byteLength,
    });

    const diffed = integrator.reduce({
      origin: "git",
      command: argv("/usr/bin/git", ["diff"]),
      capture: report(gitDiff, { artifact: true }),
    });
    expect(diffed.ok).toBe(true);
    if (!diffed.ok) {
      return;
    }
    const transformed = integrator.toEvidence({
      observation: diffed.value,
      id: "ev-diff",
    });
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) {
      return;
    }
    expect(transformed.value.fidelity).toBe("deterministic-transform");
    expect(transformed.value.exactSource).toBeNull();
    expect(transformed.value.lineage).toEqual(["hush.v6", "git.diff"]);
    expect(transformed.value.expansion).not.toBeNull();
    expect(transformed.value.payload.kind).toBe("inline");
    if (transformed.value.payload.kind === "inline") {
      expect(transformed.value.payload.text).toContain("@@");
      expect(transformed.value.payload.text).toContain("-old");
      expect(transformed.value.payload.text).toContain("+new");
    }
  });

  test("refuses evidence when the projection is empty", () => {
    const integrator = createHushIntegrator();
    const reduced = integrator.reduce({
      origin: "process",
      command: argv("/bin/true"),
      capture: report(""),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(integrator.toEvidence({ observation: reduced.value, id: "ev-empty" })).toEqual({
      ok: false,
      error: { kind: "hush-observation", code: "empty", field: "payload" },
    });
  });
});
