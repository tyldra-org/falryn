/**
 * The shipped executable, on a real terminal.
 *
 * Everything else in this area tests the shell with the terminal replaced by
 * memory. That is the right way to test behavior, and it cannot answer the
 * question this file exists for: whether `dist/falryn` — the actual artifact a
 * user runs — opens a renderer on a real tty, takes an interrupt through
 * Falryn's own signal port rather than OpenTUI's, exits with the code the one
 * table owns, and gives the terminal back.
 *
 * A pseudo-terminal is allocated through libc's `openpty`, which is the only way
 * to get a process a real tty without adding a native dependency. `script(1)`
 * cannot be used: it requires a tty on *its* own stdin, so it fails in exactly
 * the non-interactive contexts a test suite runs in.
 *
 * Restoration is asserted on the bytes the terminal received, not on a report
 * the program made about itself. A shell that claimed it restored the terminal
 * and did not would pass every other test in this repository and would leave a
 * user's window unusable.
 *
 * The check reports itself skipped rather than passed when `dist/falryn` has not
 * been built or the platform has no `openpty`. `bun run ci` builds before it
 * tests, so a release path always runs it.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { afterEach, describe, expect, test } from "bun:test";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EXIT_CODES } from "../cli/index.ts";

/** Three levels up: this file is `src/tui/`, and the artifact is `dist/` beside `src/`. */
const EXECUTABLE = join(dirname(dirname(dirname(import.meta.path))), "dist", "falryn");

/** The size the pseudo-terminal reports, and what the shell must lay out against. */
const COLUMNS = 100;
const ROWS = 30;

/** Long enough for a native renderer to start and commit a frame on a loaded machine. */
const MOUNT_MS = 3_000;

/** Long enough for the shutdown sequence, which is bounded by its own phase grace. */
const EXIT_MS = 8_000;

const RUN_TIMEOUT_MS = 30_000;

/**
 * Sequences that mean the terminal was given back.
 *
 * Each one undoes something the renderer turned on. They are asserted by value
 * rather than by a helper, because the whole point is to check what the terminal
 * actually received — a helper shared with the code under test would let both
 * sides be wrong together.
 */
const RESTORED = {
  cursorVisible: "[?25h",
  scrollRegionReset: "[r",
  bracketedPasteOff: "[?2004l",
} as const;

type Pty = {
  readonly master: number;
  readonly slave: number;
  transcript(): string;
  close(): void;
};

/**
 * A pseudo-terminal, or `null` on a platform that has no `openpty`.
 *
 * `openpty` rather than `posix_openpt` plus a `TIOCSWINSZ` ioctl: `ioctl` is
 * variadic, and a variadic call through a fixed-arity FFI declaration passes its
 * third argument in a register on arm64 where the callee reads it off the stack.
 * `openpty` takes the window size as an ordinary parameter, so the terminal has
 * a size from the moment it exists — which matters, since a terminal reporting
 * none is one the launch decision refuses.
 */
function openPty(): Pty | null {
  const master = new Int32Array(1);
  const slave = new Int32Array(1);
  // `struct winsize`: rows, columns, then pixel dimensions nothing here uses.
  const size = new Uint16Array([ROWS, COLUMNS, 0, 0]);

  try {
    const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libutil.so.1", {
      openpty: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    if (libc.symbols.openpty(ptr(master), ptr(slave), null, null, ptr(size)) !== 0) {
      return null;
    }
  } catch {
    // No such library, no such symbol, or no pseudo-terminal left to allocate.
    // The check reports itself skipped rather than failing over the platform.
    return null;
  }

  let transcript = "";
  // Streamed rather than read synchronously: a blocking read on a master with
  // nothing pending would hang the suite instead of failing it.
  const reader = createReadStream("", { fd: master[0] ?? -1, autoClose: false });
  reader.on("data", (chunk) => {
    transcript += chunk.toString();
  });
  reader.on("error", () => {
    // The far end closing is an ordinary end of a pseudo-terminal, not a failure.
  });

  return {
    master: master[0] ?? -1,
    slave: slave[0] ?? -1,
    transcript: () => transcript,
    close: () => reader.destroy(),
  };
}

const built = await stat(EXECUTABLE)
  .then(() => true)
  .catch(() => false);

const probe = built ? openPty() : null;
const runnable = built && probe !== null;
probe?.close();

const live: { process: Bun.Subprocess; pty: Pty }[] = [];

afterEach(() => {
  while (live.length > 0) {
    const run = live.pop();
    run?.process.kill("SIGKILL");
    run?.pty.close();
  }
});

type ShellRun = {
  readonly exitCode: number | "timed-out";
  readonly transcript: string;
};

/** Starts the compiled shell on a pseudo-terminal and runs `act` once it has drawn. */
async function runOnPty(
  argv: readonly string[],
  act: (started: { readonly process: Bun.Subprocess }) => void,
): Promise<ShellRun> {
  const pty = openPty();
  if (pty === null) {
    throw new Error("no pseudo-terminal");
  }

  const started = Bun.spawn([EXECUTABLE, ...argv], {
    stdin: pty.slave,
    stdout: pty.slave,
    stderr: pty.slave,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "xterm-256color",
    },
  });
  const run = { process: started, pty };
  live.push(run);

  await Bun.sleep(MOUNT_MS);
  act(run);

  const exitCode = await Promise.race([
    started.exited,
    Bun.sleep(EXIT_MS).then(() => "timed-out" as const),
  ]);
  // The bytes written on the way out arrive after the process has gone.
  await Bun.sleep(200);
  return { exitCode, transcript: pty.transcript() };
}

/**
 * Two runs, not five.
 *
 * Each one costs a pseudo-terminal, a compiled process, and several seconds of
 * a native renderer starting — so the assertions are grouped by the *path* they
 * exercise rather than one per run. Five separate spawns of the same interrupt
 * path told us nothing extra and made the file slow enough to be flaky, which is
 * worse than telling us nothing.
 */
describe.if(runnable)("the compiled shell on a real terminal", () => {
  const interrupted = runOnPty([], ({ process: started }) => started.kill("SIGINT"));

  test(
    "opens an interface and lays it out against the terminal it was given",
    async () => {
      const run = await interrupted;
      // The size the pseudo-terminal reports, drawn by the shell. A default
      // substituted for a terminal that reports none would show up here as the
      // wrong numbers rather than as nothing at all.
      expect(run.transcript).toContain(`${COLUMNS}×${ROWS}`);
      expect(run.transcript).toContain("Ctrl+C");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "takes an interrupt through Falryn's own governance and exits 130",
    async () => {
      const run = await interrupted;
      // The whole reason the renderer is created with `exitOnCtrlC: false` and
      // `exitSignals: []`. OpenTUI's default would have destroyed the renderer
      // and left the exit status to whatever happened next; this is Falryn's
      // interruption policy cancelling the scope and the one table resolving it.
      // It is also the proof the session ends at all: the shell has no quit
      // binding yet, so a run that ignored the interrupt would be a process a
      // user cannot get out of without `kill`.
      expect(run.exitCode).toBe(EXIT_CODES.CANCELLED);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "restores the terminal on the interrupt path",
    async () => {
      const run = await interrupted;
      // Asserted on the bytes the terminal received rather than on anything the
      // program said about itself. This is the failure that leaves a user
      // closing their window, and it is invisible to every other check here.
      for (const [what, sequence] of Object.entries(RESTORED)) {
        expect({ what, restored: run.transcript.includes(sequence) }).toEqual({
          what,
          restored: true,
        });
      }
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "restores the terminal when a deadline ends the session instead",
    async () => {
      // A different path to the same teardown, and one no one exercises by hand.
      // `--timeout` is the invocation scope's deadline for the shell exactly as
      // it is for a command, and it resolves to a different code through the
      // same table.
      const run = await runOnPty(["--timeout", "4000"], () => {});
      expect(run.exitCode).toBe(EXIT_CODES.TIMED_OUT);
      expect(run.transcript).toContain(RESTORED.cursorVisible);
      expect(run.transcript).toContain(RESTORED.scrollRegionReset);
    },
    RUN_TIMEOUT_MS,
  );
});

describe.if(!runnable)("the compiled shell on a real terminal", () => {
  test.skip(
    built
      ? "no pseudo-terminal is available on this platform, so the shipped artifact was not exercised"
      : "dist/falryn has not been built, so the shipped artifact was not exercised",
    () => {
      // Reported as skipped rather than silently absent, and never as passed:
      // this is the only check that runs the executable a user actually runs.
    },
  );
});
