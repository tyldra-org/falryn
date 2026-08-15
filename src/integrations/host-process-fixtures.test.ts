/**
 * Process quoting, platform, truncation, and interruption fixtures.
 *
 * #69–#73 own the ports. This file names the remaining verification matrix
 * from SHELL-PTY-AND-PROCESSES.md: argv versus Bash quoting, POSIX versus
 * Windows host limits, typed truncation, and interruption that stays distinct
 * from timeout. Product process tools are not registered here.
 */

import { describe, expect, test } from "bun:test";

import { duration, MAX_COMMAND_OUTPUT_BYTES, type ProcessCaptureRequest } from "../domain/index.ts";
import { createHostCommandRunner } from "./host-commands.ts";
import { createHostProcessCapturePort } from "./host-process-capture.ts";
import { createHostPtySessionPort } from "./host-process-sessions.ts";
import { ownedTreeSpawnOptions } from "./host-process-tree.ts";

const POSIX = process.platform !== "win32";
const platformTest = POSIX ? test : test.skip;
const ECHO = "/bin/echo";
const CAT = "/bin/cat";
const SLEEP = "/bin/sleep";
const BASH = "/bin/bash";
const HOSTILE = "$(id); rm -rf / && echo pwned";
const ENVIRONMENT = { PATH: "/usr/bin:/bin" };

const runner = createHostCommandRunner();

function argvRequest(overrides: {
  readonly executable: string;
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}) {
  return {
    executable: overrides.executable,
    argv: overrides.argv ?? [],
    environment: overrides.environment ?? {},
    timeoutMs: duration(overrides.timeoutMs ?? 5_000),
    maxOutputBytes: overrides.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES,
    signal: overrides.signal,
  };
}

function bashRequest(command: string, timeoutMs = 5_000) {
  return {
    mode: "bash" as const,
    executable: BASH,
    command,
    environment: {},
    timeoutMs: duration(timeoutMs),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
  };
}

function captureRequest(
  script: string,
  overrides: {
    readonly environment?: ProcessCaptureRequest["environment"];
    readonly timeoutMs?: ProcessCaptureRequest["timeoutMs"];
    readonly maxInlineBytes?: number;
    readonly signal?: AbortSignal;
  } = {},
): ProcessCaptureRequest {
  return {
    executable: "/bin/sh",
    argv: ["-c", script],
    environment: overrides.environment ?? ENVIRONMENT,
    timeoutMs: overrides.timeoutMs ?? duration(5_000),
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    ...(overrides.maxInlineBytes === undefined ? {} : { maxInlineBytes: overrides.maxInlineBytes }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

describe("quoting", () => {
  platformTest("direct argv keeps metacharacters as one literal argument", async () => {
    const outcome = await runner.run(argvRequest({ executable: ECHO, argv: [HOSTILE] }));
    expect(outcome).toEqual({ kind: "exited", exitCode: 0, stdout: `${HOSTILE}\n` });
  });

  platformTest("Bash mode parses a deliberate command string", async () => {
    const outcome = await runner.run(bashRequest('printf %s "$(printf parsed)"'));
    expect(outcome).toEqual({ kind: "exited", exitCode: 0, stdout: "parsed" });
  });

  platformTest("the same hostile text is not a shell line in argv mode", async () => {
    const argv = await runner.run(argvRequest({ executable: ECHO, argv: [HOSTILE] }));
    const bash = await runner.run(bashRequest(`printf %s '${HOSTILE}'`));
    expect(argv.kind === "exited" && argv.stdout).toBe(`${HOSTILE}\n`);
    expect(bash.kind === "exited" && bash.stdout).toBe(HOSTILE);
  });
});

describe("platform", () => {
  test("detached process groups are POSIX-only", () => {
    expect(ownedTreeSpawnOptions()).toEqual({ detached: POSIX });
  });

  test("Windows is skipped rather than claimed as a job-object host", () => {
    if (process.platform === "win32") {
      expect(POSIX).toBe(false);
      expect(ownedTreeSpawnOptions().detached).toBe(false);
    }
  });
});

describe("truncation", () => {
  platformTest(
    "a command past its output bound is output-exceeded, not truncated text",
    async () => {
      const outcome = await runner.run(
        argvRequest({
          executable: "/usr/bin/yes",
          argv: ["flood"],
          maxOutputBytes: 64,
          timeoutMs: 5_000,
        }),
      );
      expect(outcome).toEqual({ kind: "output-exceeded", maxOutputBytes: 64 });
    },
  );

  platformTest("capture without an artifact store stops as capture-exceeded", async () => {
    const port = createHostProcessCapturePort();
    const captured = await port.run(captureRequest("printf 'abcdefghij'", { maxInlineBytes: 4 }));
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      throw new Error("expected a capture report");
    }
    expect(captured.value.stop).toEqual({ kind: "capture-exceeded", reason: "inline" });
    expect(captured.value.stdout.truncated).toBe(true);
    expect(captured.value.stdout.inlineText).toBe("abcd");
    expect(captured.value.stdout.artifact).toBeNull();
  });
});

describe("interruption", () => {
  platformTest("an already-aborted command starts no process", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runner.run(
      argvRequest({ executable: SLEEP, argv: ["30"], signal: controller.signal }),
    );
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  platformTest("an abort during a run is cancelled rather than timed out", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 80);
    const outcome = await runner.run(
      argvRequest({
        executable: SLEEP,
        argv: ["30"],
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    );
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  platformTest("a deadline is timed-out rather than cancelled", async () => {
    const outcome = await runner.run(
      argvRequest({ executable: SLEEP, argv: ["30"], timeoutMs: 200 }),
    );
    expect(outcome).toEqual({ kind: "timed-out", timeoutMs: duration(200) });
  });

  platformTest("disabled stdin closes so cat exits instead of hanging", async () => {
    const started = Bun.nanoseconds();
    const outcome = await runner.run(argvRequest({ executable: CAT, argv: [], timeoutMs: 3_000 }));
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
    expect(outcome.kind === "exited" && outcome.exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(2_500);
  });

  platformTest("capture abort during a run records cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 80);
    const port = createHostProcessCapturePort();
    const captured = await port.run(
      captureRequest("exec /bin/sleep 30", {
        timeoutMs: duration(10_000),
        signal: controller.signal,
      }),
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      throw new Error("expected a capture report");
    }
    expect(captured.value.stop).toEqual({ kind: "cancelled" });
    expect(["terminate", "kill"]).toContain(captured.value.killStage);
  });

  platformTest("PTY interrupt delivers SIGINT and the session can exit", async () => {
    const port = createHostPtySessionPort();
    const opened = await port.open({
      executable: SLEEP,
      argv: ["30"],
      environment: ENVIRONMENT,
      dimensions: { columns: 80, rows: 24 },
      backlogBytes: 128,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error("expected a PTY session");
    }
    const interrupted = port.interrupt(opened.value.sessionId);
    expect(interrupted.ok).toBe(true);
    await waitUntil(() => {
      const state = port.snapshot(opened.value.sessionId)?.state;
      return state === "exited" || state === "uncertain";
    });
    const snapshot = port.snapshot(opened.value.sessionId);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) {
      throw new Error("expected a PTY snapshot");
    }
    expect(["exited", "uncertain"]).toContain(snapshot.state);
  });
});

describe("environment and dual streams", () => {
  platformTest("capture does not inherit undeclared parent variables", async () => {
    process.env.FALRYN_LEAK_PROBE = "leaked";
    try {
      const port = createHostProcessCapturePort();
      const captured = await port.run(
        captureRequest("/usr/bin/env", { environment: { PATH: "/usr/bin:/bin" } }),
      );
      expect(captured.ok).toBe(true);
      if (!captured.ok) {
        throw new Error("expected a capture report");
      }
      expect(captured.value.stdout.inlineText).not.toContain("leaked");
    } finally {
      delete process.env.FALRYN_LEAK_PROBE;
    }
  });

  platformTest("large dual streams keep both sides and a merged order", async () => {
    const port = createHostProcessCapturePort();
    const captured = await port.run(
      captureRequest(
        'awk \'BEGIN { for (i = 0; i < 256; i++) printf "o"; print ""; for (i = 0; i < 256; i++) printf "e" > "/dev/stderr" }\'',
      ),
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      throw new Error("expected a capture report");
    }
    expect(captured.value.stdout.inlineText?.startsWith("o")).toBe(true);
    expect(captured.value.stderr.inlineText?.startsWith("e")).toBe(true);
    expect(captured.value.stdout.byteCount).toBeGreaterThan(200);
    expect(captured.value.stderr.byteCount).toBeGreaterThan(200);
    const chunks = captured.value.events.filter((event) => event.kind === "chunk");
    const orders = chunks.map((event) => event.order);
    expect(orders).toEqual([...orders].sort((left, right) => left - right));
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition did not settle before the test deadline");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
