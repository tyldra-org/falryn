/**
 * The pseudo-terminal the shipped artifact is driven on.
 *
 * `./shell.compiled.test.ts` established this: a real tty allocated through
 * libc's `openpty`, the compiled `dist/falryn` spawned onto it, and the bytes it
 * wrote read back. `./measurement.test.tsx` needs the same terminal for the two
 * quantities a test renderer cannot answer — a test renderer runs no frame loop,
 * so cadence taken in-process measures nothing, and startup taken in-process
 * excludes process start, which is the part that costs.
 *
 * So the terminal moved here rather than being written twice. #374 is the whole
 * argument: the same setup copied into a second file is a second chance to get
 * the descriptor handling, the `SIGWINCH` delivery, or the teardown subtly
 * different, and the copies drift one correction at a time.
 *
 * Like `./harness.tsx`, this module is test support. It ships in no build —
 * `bun run build` compiles `src/main.ts` — and `./tui-boundaries.test.ts`
 * asserts that rather than trusting it.
 *
 * ## Teardown is bound to the scope, not to a hook
 *
 * For the reason the harness states: a shared module is evaluated once for the
 * whole run, so an `afterEach` written here would register against whichever
 * file loaded first and every other file would leak a process and a descriptor
 * pair. `startOnPty` returns a `Disposable` and `runOnPty` holds one with
 * `using`, so a run that threw partway through — or timed out and left a native
 * renderer alive — is still killed and closed on the way out of the scope that
 * opened it.
 *
 * ## Times are recorded as bytes arrive
 *
 * A transcript alone cannot say *when* something was drawn, and both compiled
 * measurements are questions about when. Each chunk read off the master is
 * stamped, so `arrivalOf` can answer what time the byte at a given offset
 * reached the terminal — which is how startup-to-first-draw and the interval
 * between two frames are measured rather than inferred from a wall-clock read
 * taken somewhere else.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, createReadStream, writeSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Three levels up: this file is `src/tui/`, and the artifact is `dist/` beside `src/`. */
export const EXECUTABLE = join(dirname(dirname(dirname(import.meta.path))), "dist", "falryn");

/** The size the pseudo-terminal reports, and what the shell must lay out against. */
export const COLUMNS = 100;
export const ROWS = 30;

/** Long enough for a native renderer to start and commit a frame on a loaded machine. */
export const MOUNT_MS = 3_000;

/** Long enough for the shutdown sequence, which is bounded by its own phase grace. */
export const EXIT_MS = 8_000;

/** Bytes a step drew, once the interface stopped drawing more. */
export const QUIET_MS = 300;
export const STEP_TIMEOUT_MS = 4_000;

/**
 * The start of a synchronized update, which is where one frame ends and the
 * next begins.
 *
 * A step can draw more than one: a resize repaints at the size it had before
 * re-laying out at the size it was given, so a step's bytes hold a transition
 * and not a state. Asserting on the whole slice would read both frames and pass
 * on whichever one happened to match.
 */
export const FRAME_START = "\u001b[?2026h";

/**
 * Sequences that mean the terminal was given back.
 *
 * Each one undoes something the renderer turned on. They are asserted by value
 * rather than by a helper, because the whole point is to check what the terminal
 * actually received — a helper shared with the code under test would let both
 * sides be wrong together.
 */
export const RESTORED = {
  cursorVisible: "\u001b[?25h",
  scrollRegionReset: "\u001b[r",
  bracketedPasteOff: "\u001b[?2004l",
} as const;

export type Pty = {
  readonly master: number;
  readonly slave: number;
  transcript(): string;
  /**
   * When the byte at `offset` reached the terminal, in `Bun.nanoseconds()`.
   *
   * The arrival of the *chunk* that carried it, which is the resolution a
   * terminal has: bytes within one read are indistinguishable in time. `null`
   * when the transcript is not that long yet.
   */
  arrivalOf(offset: number): number | null;
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
export function openPty(columns = COLUMNS, rows = ROWS): Pty | null {
  const master = new Int32Array(1);
  const slave = new Int32Array(1);
  // `struct winsize`: rows, columns, then pixel dimensions nothing here uses.
  const size = new Uint16Array([rows, columns, 0, 0]);

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
  /** One entry per read: the transcript length after it, and when it arrived. */
  const arrivals: { readonly end: number; readonly at: number }[] = [];
  // Streamed rather than read synchronously: a blocking read on a master with
  // nothing pending would hang the suite instead of failing it.
  const reader = createReadStream("", { fd: master[0] ?? -1, autoClose: false });
  reader.on("data", (chunk) => {
    transcript += chunk.toString();
    arrivals.push({ end: transcript.length, at: Bun.nanoseconds() });
  });
  reader.on("error", () => {
    // The far end closing is an ordinary end of a pseudo-terminal, not a failure.
  });

  return {
    master: master[0] ?? -1,
    slave: slave[0] ?? -1,
    transcript: () => transcript,
    arrivalOf(offset) {
      for (const arrival of arrivals) {
        if (offset < arrival.end) {
          return arrival.at;
        }
      }
      return null;
    },
    // The reader only. The master descriptor is deliberately left open, and
    // this was measured rather than assumed: `destroy()` schedules the stream's
    // teardown, so closing the descriptor here races a read that has not
    // finished — and the number is reused by the next `openpty`, which means
    // the stream can end up closing a terminal that belongs to someone else.
    // The suite hung rather than failed. The leak is bounded by the run and
    // belongs to whoever fixes it deliberately.
    close: () => reader.destroy(),
  };
}

/** Whether `dist/falryn` exists to be run at all. */
export const compiledArtifactBuilt = await stat(EXECUTABLE)
  .then(() => true)
  .catch(() => false);

const probe = compiledArtifactBuilt ? openPty() : null;

/** Whether the shipped artifact can be exercised on this host. */
export const compiledShellRunnable = compiledArtifactBuilt && probe !== null;

/**
 * Whether the terminal can be resized under a running child.
 *
 * Through `stty` rather than through `ioctl` directly, and this is a measured
 * constraint rather than a preference: `ioctl` is variadic, and calling it
 * through a fixed-arity FFI declaration segfaults the process on arm64 — the
 * third argument goes in a register where the callee reads the stack. `stty` is
 * POSIX, ships with the system, and reaches `TIOCSWINSZ` from a real C program,
 * which is the same thing a terminal emulator does.
 */
export const resizable =
  probe !== null &&
  (await Bun.spawn(["stty", "size"], { stdin: probe.master, stdout: "ignore", stderr: "ignore" })
    .exited.then((code) => code === 0)
    .catch(() => false));

probe?.close();

export type StartOptions = {
  readonly columns?: number;
  readonly rows?: number;
  readonly env?: Readonly<Record<string, string>>;
};

/**
 * The shell running on its own terminal, disposed with the scope that started it.
 *
 * `spawnedAt` is read immediately before the spawn, so a caller measuring
 * startup is measuring from the moment the process was asked for rather than
 * from some earlier point in its own setup.
 */
export type Started = Disposable & {
  readonly process: Bun.Subprocess;
  readonly pty: Pty;
  readonly spawnedAt: number;
};

/** Starts the compiled shell on a fresh pseudo-terminal. Throws when there is none. */
export function startOnPty(argv: readonly string[], options: StartOptions = {}): Started {
  const pty = openPty(options.columns ?? COLUMNS, options.rows ?? ROWS);
  if (pty === null) {
    throw new Error("no pseudo-terminal");
  }

  const spawnedAt = Bun.nanoseconds();
  const started = Bun.spawn([EXECUTABLE, ...argv], {
    stdin: pty.slave,
    stdout: pty.slave,
    stderr: pty.slave,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "xterm-256color",
      ...options.env,
    },
  });

  // The parent's copy of the slave, released as soon as the child has its own.
  // Standard practice for a pseudo-terminal, and load-bearing here: a suite that
  // opens one per screen mode leaks a descriptor pair per run without it, and
  // the master is left holding a writer that never goes away. The master itself
  // stays open — the reader owns it until `close()`.
  try {
    closeSync(pty.slave);
  } catch {
    // Already released. Harmless, and not worth failing a run over.
  }

  return {
    process: started,
    pty,
    spawnedAt,
    [Symbol.dispose]: () => {
      started.kill("SIGKILL");
      pty.close();
    },
  };
}

/**
 * Waits until `needle` has been written to the terminal, and answers where.
 *
 * The offset rather than the text, because the caller's next question is when it
 * arrived. `-1` when it never does, which a measurement reports as unmeasured
 * rather than as a fast zero.
 */
export async function waitForBytes(pty: Pty, needle: string, timeoutMs: number): Promise<number> {
  const deadline = Bun.nanoseconds() + timeoutMs * 1_000_000;
  while (Bun.nanoseconds() < deadline) {
    const at = pty.transcript().indexOf(needle);
    if (at !== -1) {
      return at;
    }
    // Short, because what is being measured is when a byte arrived rather than
    // when this loop noticed: `arrivalOf` is stamped by the reader.
    await Bun.sleep(2);
  }
  return -1;
}

/**
 * Waits until the interface stops drawing, and answers the transcript's length.
 *
 * The same quiet window the compiled walk reads its steps by. A caller slices
 * between two of these to get what one step drew.
 */
export async function waitForQuiet(
  pty: Pty,
  options: { readonly quietMs?: number; readonly timeoutMs?: number } = {},
): Promise<number> {
  const quietMs = options.quietMs ?? QUIET_MS;
  const deadline = Bun.nanoseconds() + (options.timeoutMs ?? STEP_TIMEOUT_MS) * 1_000_000;
  let quietSince = Bun.nanoseconds();
  let seen = pty.transcript().length;

  while (Bun.nanoseconds() < deadline) {
    await Bun.sleep(50);
    const now = pty.transcript().length;
    if (now !== seen) {
      seen = now;
      quietSince = Bun.nanoseconds();
      continue;
    }
    if (Bun.nanoseconds() - quietSince >= quietMs * 1_000_000) {
      break;
    }
  }
  return pty.transcript().length;
}

/** Where each frame in `[from, to)` began, as transcript offsets. */
export function frameOffsets(pty: Pty, from: number, to: number): readonly number[] {
  const transcript = pty.transcript();
  const offsets: number[] = [];
  for (let at = transcript.indexOf(FRAME_START, from); at !== -1 && at < to; ) {
    offsets.push(at);
    at = transcript.indexOf(FRAME_START, at + FRAME_START.length);
  }
  return offsets;
}

/** The frame a step settled on, rather than every frame it passed through. */
export function settledFrame(step: string): string {
  const frames = step.split(FRAME_START);
  return frames[frames.length - 1] ?? step;
}

export type ShellRun = {
  readonly exitCode: number | "timed-out";
  readonly transcript: string;
};

/**
 * The interface, driven one step at a time.
 *
 * `press` and `resize` return *what that step drew*, which is the only way to
 * assert that something closed: a pseudo-terminal's transcript is cumulative, so
 * "Help" is in it forever once the overlay has been open, and an assertion
 * against the whole transcript can only ever say a thing appeared.
 */
export type Driver = {
  readonly process: Bun.Subprocess;
  readonly pty: Pty;
  /** Writes bytes as input and returns what the interface drew in response. */
  press(bytes: string | readonly number[]): Promise<string>;
  /** Resizes the terminal under the running shell and returns what it redrew. */
  resize(columns: number, rows: number): Promise<string>;
};

/** Writes bytes to the terminal as if they had been typed into it. */
export function write(pty: Pty, bytes: string | readonly number[]): void {
  writeSync(pty.master, Buffer.from(typeof bytes === "string" ? bytes : Uint8Array.from(bytes)));
}

/**
 * Resizes the terminal under a running child, and tells it.
 *
 * The kernel signals the foreground process group of a *controlling* terminal,
 * and a spawned child has none — `setsid` plus `TIOCSCTTY` is the other half of
 * what a terminal emulator does, and `TIOCSCTTY` is an `ioctl`. The size is
 * genuinely changed here; the signal delivers the notification the kernel would
 * have.
 */
export async function resizeUnder(
  run: { readonly process: Bun.Subprocess; readonly pty: Pty },
  columns: number,
  rows: number,
): Promise<void> {
  const stty = Bun.spawn(["stty", "rows", String(rows), "columns", String(columns)], {
    stdin: run.pty.master,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await stty.exited) !== 0) {
    throw new Error(`stty could not resize the terminal to ${columns}x${rows}`);
  }
  run.process.kill("SIGWINCH");
}

/** Starts the compiled shell on a pseudo-terminal and runs `act` once it has drawn. */
export async function runOnPty(
  argv: readonly string[],
  act: (driver: Driver) => void | Promise<void>,
  options: StartOptions = {},
): Promise<ShellRun> {
  using started = startOnPty(argv, options);
  const { pty } = started;

  await Bun.sleep(MOUNT_MS);

  let read = pty.transcript().length;
  /** Waits until the interface stops drawing, and returns what this step drew. */
  const drawn = async (): Promise<string> => {
    const end = await waitForQuiet(pty);
    const step = pty.transcript().slice(read, end);
    read = end;
    return step;
  };

  // Everything the mount itself drew, consumed before the first step. Without
  // this the first step's slice carries the last frame of the *previous* state,
  // and an assertion that the arrangement changed reads both and passes on the
  // wrong one.
  await drawn();

  await act({
    process: started.process,
    pty,
    async press(bytes) {
      write(pty, bytes);
      return await drawn();
    },
    async resize(columns, rows) {
      await resizeUnder(started, columns, rows);
      return await drawn();
    },
  });

  const exitCode = await Promise.race([
    started.process.exited,
    Bun.sleep(EXIT_MS).then(() => "timed-out" as const),
  ]);
  // The bytes written on the way out arrive after the process has gone.
  await Bun.sleep(200);
  return { exitCode, transcript: pty.transcript() };
}
