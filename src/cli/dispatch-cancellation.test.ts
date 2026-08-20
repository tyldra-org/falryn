/**
 * What one invocation emits when it is stopped.
 *
 * The exit codes and the real signal are `src/cli/process-boundary.test.ts`,
 * which spawns processes because neither is observable in-process. What is
 * observable here is the thing a consumer depends on and cannot see from
 * outside: that a run stopped mid-work still produces exactly one terminal
 * record, in the format it was asked for, and that stdout stays clean.
 *
 * The command is held rather than raced. `doctor` finishes in roughly 50 ms, so
 * a test that cancelled after a delay would be asserting a scheduler's timing;
 * holding the filesystem it reads makes the cancellation land while the work is
 * genuinely in flight, every time.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScopeTree } from "../application/index.ts";
import {
  createInMemoryFileSystem,
  createManualClock,
  createStaticEnvironment,
  type FileSystemPort,
  instant,
  localPath,
  type ScopeId,
  scopeId,
} from "../domain/index.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { InvocationGovernance } from "./invocation-scope.ts";
import type { GlobalOptions } from "./options.ts";
import { readCliStream } from "./schema.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

const INVOCATION: ScopeId = scopeId.from("test-invocation");

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * A filesystem whose every read waits until the test lets it go.
 *
 * `held` resolves on the first call, which is the moment the command is in
 * flight. Each call then waits on `release`, so nothing completes until the
 * test has decided what stops the invocation.
 */
function heldFileSystem(): {
  readonly fileSystem: FileSystemPort;
  readonly held: Promise<void>;
  release(): void;
} {
  const base = createInMemoryFileSystem({
    nodes: {
      "/workspace": { kind: "directory" },
    },
  });
  let announce: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let letGo: () => void = () => {};
  const release = new Promise<void>((resolve) => {
    letGo = resolve;
  });

  const hold = async (): Promise<void> => {
    announce();
    await release;
  };

  return {
    held,
    release: () => letGo(),
    fileSystem: {
      ...base,
      async realPath(path, signal) {
        await hold();
        return base.realPath(path, signal);
      },
      async stat(path, signal) {
        await hold();
        return base.stat(path, signal);
      },
      async readText(path, maximumBytes, signal) {
        await hold();
        return base.readText(path, maximumBytes, signal);
      },
      async list(path, signal) {
        await hold();
        return base.list(path, signal);
      },
      async probeWritable(path, signal) {
        await hold();
        return base.probeWritable(path, signal);
      },
    },
  };
}

async function stoppedRun(
  argv: readonly string[],
  stop: (governance: InvocationGovernance) => void | Promise<void>,
  timeoutMs: number | null = null,
) {
  const home = await mkdtemp(join(tmpdir(), "falryn-stopped-"));
  homes.push(home);

  const clock = createManualClock(instant(0));
  const governance: InvocationGovernance = {
    clock,
    scopes: createScopeTree({ clock }),
    scopeId: INVOCATION,
  };
  const held = heldFileSystem();
  const streams = createRecordingCliStreams();

  const services = (globals: GlobalOptions) =>
    createServiceProvider(globals, {
      home: localPath(home),
      platform: "darwin",
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
      fileSystem: held.fileSystem,
      currentDirectory: localPath("/workspace"),
    });

  const running = dispatch({
    argv: [...argv, ...(timeoutMs === null ? [] : ["--timeout", String(timeoutMs)])],
    streams,
    services,
    governance,
  });

  // The work is now inside the command, which is where an interrupt or an
  // expiry has to land for any of this to mean anything.
  await held.held;
  await stop(governance);
  const code = await running;
  held.release();

  return {
    code,
    out: streams.resultWrites().join(""),
    err: streams.diagnosticWrites().join(""),
  };
}

const interrupted = (governance: InvocationGovernance): void => {
  // Exactly what the interruption policy does on a signal: cancel the root, and
  // let cancellation travel down to the invocation derived under it.
  governance.scopes.cancel(governance.scopes.root().scopeId, { kind: "requested" });
};

const expired = (governance: InvocationGovernance): Promise<void> =>
  (governance.clock as ReturnType<typeof createManualClock>).advanceTo(instant(5_000));

describe("an invocation stopped mid-work", () => {
  test("emits exactly one terminal record in each machine format", async () => {
    for (const format of ["json", "jsonl"]) {
      const cancelled = await stoppedRun(["doctor", "--format", format], interrupted);
      const reading = readCliStream(cancelled.out.split("\n"));

      expect(reading.records.filter((record) => record.terminal)).toHaveLength(1);
      expect(reading.terminal?.kind).toBe("result");
      expect(reading.refusals).toEqual([]);
      // A stream that stopped mid-sequence is what leaves a reader waiting.
      expect(reading.gaps).toEqual([]);
      expect(cancelled.code).toBe(EXIT_CODES.CANCELLED);
    }
  });

  test("reports the deadline it exceeded rather than a cancellation", async () => {
    const run = await stoppedRun(["doctor", "--format", "json"], expired, 5_000);
    const terminal = readCliStream(run.out.split("\n")).terminal as {
      outcome?: { kind: string; effect?: string };
      payload?: unknown;
    } | null;

    expect(terminal?.outcome).toEqual({ kind: "timed-out", effect: "none" });
    // No payload: the command never answered, and inventing one would report a
    // diagnosis the run did not reach.
    expect(terminal?.payload).toBeNull();
    expect(run.code).toBe(EXIT_CODES.TIMED_OUT);
  });

  test("keeps quiet stdout empty while the verdict reaches the exit status", async () => {
    const run = await stoppedRun(["doctor", "--format", "quiet"], interrupted);

    expect(run.out).toBe("");
    expect(run.code).toBe(EXIT_CODES.CANCELLED);
  });

  test("says how it ended on stderr in the human projection", async () => {
    const run = await stoppedRun(["config", "show"], interrupted);

    expect(run.err).toContain("Cancelled");
    expect(run.code).toBe(EXIT_CODES.CANCELLED);
  });

  test("carries the same verdict for every command it can stop", async () => {
    for (const argv of [["doctor"], ["config", "show"], ["config", "validate"]]) {
      const run = await stoppedRun([...argv, "--format", "json"], interrupted);
      const terminal = readCliStream(run.out.split("\n")).terminal as {
        command?: string;
        outcome?: { kind: string; effect?: string };
      } | null;

      // The record still names the command that was running, so a consumer can
      // tell which invocation it lost.
      expect(terminal?.command).toBe(argv.join("."));
      expect(terminal?.outcome).toEqual({ kind: "cancelled", effect: "none" });
      expect(run.code).toBe(EXIT_CODES.CANCELLED);
    }
  });

  test("reports uncertain effect when the run had already changed something", async () => {
    const run = await stoppedRun(["doctor", "--format", "json"], (governance) => {
      governance.scopes.recordEffect(INVOCATION, "partial");
      interrupted(governance);
    });
    const terminal = readCliStream(run.out.split("\n")).terminal as {
      outcome?: { kind: string; effect?: string };
      effect?: { observed: string };
    } | null;

    expect(terminal?.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    // The record agrees with its own outcome: a run that may have changed
    // something does not report having observed nothing.
    expect(terminal?.effect?.observed).toBe("uncertain");
    expect(run.code).toBe(EXIT_CODES.UNCERTAIN_EFFECT);
  });
});

describe("an invocation nothing stopped", () => {
  test("is unchanged by a --timeout it never reaches", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-stopped-"));
    homes.push(home);
    const clock = createManualClock(instant(0));

    async function run(argv: readonly string[]) {
      const streams = createRecordingCliStreams();
      const code = await dispatch({
        argv,
        streams,
        governance: { clock, scopes: createScopeTree({ clock }) },
        services: (globals: GlobalOptions) =>
          createServiceProvider(globals, {
            home: localPath(home),
            platform: "darwin",
            environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
          }),
      });
      return { code, out: streams.resultWrites().join("") };
    }

    const generous = await run(["config", "validate", "--timeout", "60000"]);
    const none = await run(["config", "validate"]);

    // The deadline is the only difference, and it changed nothing: same output,
    // same status.
    expect(generous.out).toBe(none.out);
    expect(generous.code).toBe(EXIT_CODES.COMPLETED);
    expect(none.code).toBe(EXIT_CODES.COMPLETED);
  });
});
