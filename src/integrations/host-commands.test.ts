/**
 * The supervised command adapter, against real processes.
 *
 * Every other test in this area drives a stub, which proves what callers do
 * with an outcome and proves nothing about how an outcome is produced. This is
 * the only file that starts a process, so it is the only place the controls the
 * credential boundary rests on are actually enforced: an environment that is
 * supplied rather than inherited, an argument vector no shell parses, a hard
 * output bound, a deadline, an abort, and a `stderr` that never comes back.
 *
 * The commands used are short-lived POSIX utilities at absolute paths, matching
 * how the port is used in production. macOS is the qualified target; these
 * paths hold on any POSIX host Falryn currently builds for.
 */

import { describe, expect, test } from "bun:test";

import {
  duration,
  MAX_COMMAND_ARGUMENTS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_COMMAND_SCRIPT_BYTES,
} from "../domain/index.ts";
import { createHostCommandRunner } from "./host-commands.ts";

const runner = createHostCommandRunner();

const ECHO = "/bin/echo";
const ENV = "/usr/bin/env";
const BASH = "/bin/bash";
const CAT = "/bin/cat";
const SHELL = "/bin/sh";
const SLEEP = "/bin/sleep";
/** Writes without stopping, which is what an output bound has to survive. */
const FLOOD = "/usr/bin/yes";

function request(overrides: {
  readonly executable: string;
  readonly argv?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly stdinBytes?: Uint8Array;
}) {
  return {
    executable: overrides.executable,
    argv: overrides.argv ?? [],
    environment: overrides.environment ?? {},
    timeoutMs: duration(overrides.timeoutMs ?? 5_000),
    maxOutputBytes: overrides.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES,
    signal: overrides.signal,
    stdinBytes: overrides.stdinBytes,
  };
}

function bashRequest(overrides: {
  readonly command: string;
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}) {
  return {
    mode: "bash" as const,
    executable: overrides.executable ?? BASH,
    command: overrides.command,
    environment: overrides.environment ?? {},
    ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
    timeoutMs: duration(overrides.timeoutMs ?? 5_000),
    maxOutputBytes: overrides.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

describe("running a command", () => {
  test("returns the exit code and stdout", async () => {
    const outcome = await runner.run(request({ executable: ECHO, argv: ["hello"] }));

    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") {
      throw new Error("expected an exited outcome");
    }
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("hello\n");
  });

  test("reports a non-zero exit code rather than throwing", async () => {
    // The keychain adapter routes entirely on this number, so it has to arrive
    // intact for every value, not only for zero.
    const outcome = await runner.run(request({ executable: SHELL, argv: ["-c", "exit 44"] }));
    expect(outcome.kind === "exited" && outcome.exitCode).toBe(44);
  });

  test("delivers bounded input through stdin instead of argv or environment", async () => {
    const input = new TextEncoder().encode("protected input\n");
    const outcome = await runner.run(request({ executable: CAT, stdinBytes: input }));
    expect(outcome).toEqual({ kind: "exited", exitCode: 0, stdout: "protected input\n" });
  });

  test("runs an intentional Bash script through the selected interpreter", async () => {
    const outcome = await runner.run(
      bashRequest({
        command: `case "$-" in *i*) exit 91;; *) printf '%s\\n' "$FALRYN_BASH_VALUE";; esac`,
        environment: { FALRYN_BASH_VALUE: "bash value" },
      }),
    );

    expect(outcome).toEqual({ kind: "exited", exitCode: 0, stdout: "bash value\n" });
  });

  test("passes the requested working directory to either execution mode", async () => {
    const cwd = process.cwd();
    const direct = await runner.run(request({ executable: "/bin/pwd", cwd }));
    const bash = await runner.run(bashRequest({ command: "pwd", cwd }));

    expect(direct.kind === "exited" && direct.stdout).toBe(`${cwd}\n`);
    expect(bash.kind === "exited" && bash.stdout).toBe(`${cwd}\n`);
  });
});

describe("the child environment is supplied, not inherited", () => {
  test("an empty environment reaches the child empty", async () => {
    // The parent process has a populated environment; the child must not see
    // any of it, because it is full of other people's credentials.
    const outcome = await runner.run(request({ executable: ENV, environment: {} }));
    expect(outcome.kind === "exited" && outcome.stdout).toBe("");
  });

  test("only what was supplied reaches the child", async () => {
    const outcome = await runner.run(
      request({ executable: ENV, environment: { FALRYN_TEST_ONLY: "value" } }),
    );
    expect(outcome.kind === "exited" && outcome.stdout).toBe("FALRYN_TEST_ONLY=value\n");
  });

  test("a variable set in this process is not visible to the child", async () => {
    process.env.FALRYN_LEAK_PROBE = "leaked";
    try {
      const outcome = await runner.run(request({ executable: ENV, environment: {} }));
      expect(outcome.kind === "exited" && outcome.stdout).not.toContain("leaked");
    } finally {
      delete process.env.FALRYN_LEAK_PROBE;
    }
  });
});

describe("the argument vector is never parsed by a shell", () => {
  test("shell metacharacters arrive as literal text", async () => {
    const hostile = "$(id); rm -rf / && echo pwned | tee /tmp/x";
    const outcome = await runner.run(request({ executable: ECHO, argv: [hostile] }));

    expect(outcome.kind === "exited" && outcome.stdout).toBe(`${hostile}\n`);
  });

  test("a variable reference is not expanded", async () => {
    const outcome = await runner.run(
      request({ executable: ECHO, argv: ["$HOME"], environment: { HOME: "/expanded" } }),
    );
    expect(outcome.kind === "exited" && outcome.stdout).toBe("$HOME\n");
  });

  test("an argument vector past the bound is refused before anything starts", async () => {
    const outcome = await runner.run(
      request({
        executable: ECHO,
        argv: Array.from({ length: MAX_COMMAND_ARGUMENTS + 1 }, (_value, index) => String(index)),
      }),
    );
    expect(outcome).toEqual({ kind: "spawn-failed", code: "too-many-arguments" });
  });
});

describe("request validation", () => {
  test("refuses a relative executable without starting a process", async () => {
    const outcome = await runner.run(request({ executable: "echo", argv: ["no"] }));

    expect(outcome).toEqual({ kind: "spawn-failed", code: "invalid-executable" });
  });

  test("bounds Bash source before spawning", async () => {
    const outcome = await runner.run(
      bashRequest({ command: "x".repeat(MAX_COMMAND_SCRIPT_BYTES + 1) }),
    );

    expect(outcome).toEqual({ kind: "spawn-failed", code: "command-too-large" });
  });
});

describe("the output bound", () => {
  test("a command that writes past its bound is stopped and reported as such", async () => {
    const started = Bun.nanoseconds();
    const outcome = await runner.run(
      request({ executable: FLOOD, argv: ["flood"], maxOutputBytes: 256, timeoutMs: 10_000 }),
    );
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    expect(outcome).toEqual({ kind: "output-exceeded", maxOutputBytes: 256 });
    // The point of the fix this asserts: the child is killed when the bound is
    // reached, not left blocked on a full pipe until its deadline expires. A
    // deadline-shaped answer would tell the caller the command was slow when it
    // was in fact too loud.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test("output exactly at the bound is returned whole", async () => {
    // `echo` adds a newline, so eight characters plus it is nine bytes.
    const outcome = await runner.run(
      request({ executable: ECHO, argv: ["12345678"], maxOutputBytes: 9 }),
    );
    expect(outcome.kind === "exited" && outcome.stdout).toBe("12345678\n");
  });

  test("output one byte past the bound is refused rather than truncated", async () => {
    const outcome = await runner.run(
      request({ executable: ECHO, argv: ["12345678"], maxOutputBytes: 8 }),
    );
    expect(outcome.kind).toBe("output-exceeded");
  });

  test("a requested bound larger than the declared maximum is capped", async () => {
    const outcome = await runner.run(
      request({
        executable: FLOOD,
        argv: ["flood"],
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES * 10,
        timeoutMs: 10_000,
      }),
    );
    expect(outcome).toEqual({
      kind: "output-exceeded",
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    });
  });
});

describe("the deadline", () => {
  test("a command that outlives its deadline is killed and reported timed out", async () => {
    const started = Bun.nanoseconds();
    const outcome = await runner.run(request({ executable: SLEEP, argv: ["30"], timeoutMs: 250 }));
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    expect(outcome).toEqual({ kind: "timed-out", timeoutMs: duration(250) });
    // Killed near the deadline rather than run to completion.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  test("a shell waiting on a grandchild times out instead of running to completion", async () => {
    const started = Bun.nanoseconds();
    const outcome = await runner.run(
      bashRequest({
        command: 'trap "" HUP; /bin/sleep 30 & wait',
        timeoutMs: 400,
      }),
    );
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    expect(outcome).toEqual({ kind: "timed-out", timeoutMs: duration(400) });
    expect(elapsedMs).toBeLessThan(10_000);
  });

  test("a command that finishes inside its deadline is not affected by it", async () => {
    const outcome = await runner.run(
      request({ executable: ECHO, argv: ["fast"], timeoutMs: 5_000 }),
    );
    expect(outcome.kind).toBe("exited");
  });
});

describe("cancellation", () => {
  test("an already-aborted request starts no process", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runner.run(
      request({ executable: SLEEP, argv: ["30"], signal: controller.signal }),
    );
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  test("an abort during the run kills the child and reports cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);

    const started = Bun.nanoseconds();
    const outcome = await runner.run(
      request({
        executable: SLEEP,
        argv: ["30"],
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    );
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    // Cancelled, not timed out: the two are different facts and the deadline
    // here is long enough that confusing them would be visible.
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe("failures that are not exits", () => {
  test("an executable that does not exist reports a spawn failure", async () => {
    const outcome = await runner.run(
      request({ executable: "/usr/bin/falryn-definitely-not-installed" }),
    );

    expect(outcome.kind).toBe("spawn-failed");
    if (outcome.kind !== "spawn-failed") {
      throw new Error("expected a spawn failure");
    }
    // A code, not a message: a spawn failure's text carries the absolute path
    // and sometimes the argument vector.
    expect(outcome.code).toMatch(/^[A-Z]{2,16}$/);
    expect(JSON.stringify(outcome)).not.toContain("falryn-definitely-not-installed");
  });
});

describe("stderr never crosses the boundary", () => {
  test("a command that writes only to stderr returns empty stdout and no error text", async () => {
    const outcome = await runner.run(
      request({
        executable: SHELL,
        argv: ["-c", "echo 'quoted the secret sk-live-abcdef' >&2; exit 3"],
      }),
    );

    expect(outcome.kind).toBe("exited");
    if (outcome.kind !== "exited") {
      throw new Error("expected an exited outcome");
    }
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stdout).toBe("");
    // There is no field it could have arrived in, and none appears.
    expect(JSON.stringify(outcome)).not.toContain("sk-live");
    expect(Object.keys(outcome).sort()).toEqual(["exitCode", "kind", "stdout"]);
  });

  test("a command whose stderr is larger than any bound still completes", async () => {
    // stderr is drained to completion rather than to a bound, so a noisy child
    // can never block on a full pipe and stall the whole call.
    const outcome = await runner.run(
      request({
        executable: SHELL,
        argv: [
          "-c",
          `i=0; while [ $i -lt 2000 ]; do echo "noisy line of stderr output" >&2; i=$((i+1)); done; echo done`,
        ],
        timeoutMs: 15_000,
      }),
    );

    expect(outcome.kind === "exited" && outcome.stdout).toBe("done\n");
  });
});
