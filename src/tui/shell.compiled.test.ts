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
import { closeSync, createReadStream, writeSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EXIT_CODES } from "../cli/index.ts";
import { emulateScreen, rowsCarryingMarksFromMultipleGroups } from "./emulated-screen-fixtures.ts";

/** Three levels up: this file is `src/tui/`, and the artifact is `dist/` beside `src/`. */
const EXECUTABLE = join(dirname(dirname(dirname(import.meta.path))), "dist", "falryn");

/**
 * The compiled smoke targets, and which of them this file can qualify.
 *
 * A pseudo-terminal here comes from libc's `openpty`, so only the POSIX targets
 * are qualifiable. `win32-x64` is a recognized target rather than an error —
 * the Windows smoke job selects it and runs the CLI check alone — but it is not
 * one this file asserts, so it must not turn a skipped terminal check into a
 * passing terminal qualification.
 */
const SMOKE_TARGETS = ["darwin-arm64", "win32-x64"] as const;
const PSEUDO_TERMINAL_SMOKE_TARGETS = ["darwin-arm64"] as const;

type SmokeTarget = (typeof SMOKE_TARGETS)[number];

function isSmokeTarget(value: string): value is SmokeTarget {
  return SMOKE_TARGETS.some((target) => target === value);
}

const requestedSmokeTarget = process.env.FALRYN_COMPILED_SMOKE_TARGET;

if (requestedSmokeTarget !== undefined && !isSmokeTarget(requestedSmokeTarget)) {
  throw new Error(`unknown compiled smoke target: ${requestedSmokeTarget}`);
}

const requiresMacosArm64 =
  requestedSmokeTarget !== undefined &&
  PSEUDO_TERMINAL_SMOKE_TARGETS.some((target) => target === requestedSmokeTarget);

/** The size the pseudo-terminal reports, and what the shell must lay out against. */
const COLUMNS = 100;
const ROWS = 30;

/** Long enough for a native renderer to start and commit a frame on a loaded machine. */
const MOUNT_MS = 3_000;

/** Long enough for the shutdown sequence, which is bounded by its own phase grace. */
const EXIT_MS = 8_000;

const RUN_TIMEOUT_MS = 30_000;

/** Escape itself, as an escape rather than a raw byte. */
const ESC = "\u001b";

/** The control sequence introducer, as a regular-expression fragment. */
const CSI = `${ESC}\\[`;

/**
 * Sequences that mean the terminal was given back.
 *
 * Each one undoes something the renderer turned on. They are asserted by value
 * rather than by a helper, because the whole point is to check what the terminal
 * actually received — a helper shared with the code under test would let both
 * sides be wrong together.
 */
const RESTORED = {
  alternateScreen: "\u001b[?1049l",
  cursorVisible: "\u001b[?25h",
  bracketedPasteOff: "\u001b[?2004l",
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
function openPty(columns = COLUMNS, rows = ROWS): Pty | null {
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
const resizable =
  probe !== null &&
  (await Bun.spawn(["stty", "size"], { stdin: probe.master, stdout: "ignore", stderr: "ignore" })
    .exited.then((code) => code === 0)
    .catch(() => false));

const runnable = built && probe !== null;
probe?.close();

if (requiresMacosArm64) {
  test("requires a runnable macOS arm64 pseudo-terminal target", () => {
    // The general suite records a host without this facility as unqualified.
    // The selected CI target instead fails explicitly, including when its
    // resize path would otherwise be skipped.
    expect(built).toBe(true);
    expect(process.platform).toBe("darwin");
    expect(process.arch).toBe("arm64");
    expect(runnable).toBe(true);
    expect(resizable).toBe(true);
  });
}

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

/**
 * The start of a synchronized update, which is where one frame ends and the
 * next begins.
 *
 * A step can draw more than one: a resize repaints at the size it had before
 * re-laying out at the size it was given, so a step's bytes hold a transition
 * and not a state. Asserting on the whole slice would read both frames and pass
 * on whichever one happened to match.
 */
const FRAME_START = "\u001b[?2026h";

/**
 * Every sequence that means the terminal was given back, on one run.
 *
 * A function rather than four copies of the loop, because the copies are how
 * three of the paths this file drives ended up asserting an exit status and
 * nothing about the terminal they left behind.
 */
function expectRestored(run: ShellRun): void {
  for (const [what, sequence] of Object.entries(RESTORED)) {
    expect({ what, restored: run.transcript.includes(sequence) }).toEqual({
      what,
      restored: true,
    });
  }
}

/** The frame a step settled on, rather than every frame it passed through. */
function settledFrame(step: string): string {
  const frames = step.split(FRAME_START);
  return frames[frames.length - 1] ?? step;
}

/** Bytes a step drew, once the interface stopped drawing more. */
const QUIET_MS = 300;
const STEP_TIMEOUT_MS = 4_000;

/**
 * The interface, driven one step at a time.
 *
 * `press` and `resize` return *what that step drew*, which is the only way to
 * assert that something closed: a pseudo-terminal's transcript is cumulative, so
 * "Help" is in it forever once the overlay has been open, and an assertion
 * against the whole transcript can only ever say a thing appeared.
 */
type Driver = {
  readonly process: Bun.Subprocess;
  readonly pty: Pty;
  /** Writes bytes as input and returns what the interface drew in response. */
  press(bytes: string | readonly number[]): Promise<string>;
  /** Resizes the terminal under the running shell and returns what it redrew. */
  resize(columns: number, rows: number): Promise<string>;
};

/** Starts the compiled shell on a pseudo-terminal and runs `act` once it has drawn. */
async function runOnPty(
  argv: readonly string[],
  act: (driver: Driver) => void | Promise<void>,
  options: {
    readonly columns?: number;
    readonly rows?: number;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<ShellRun> {
  const pty = openPty(options.columns ?? COLUMNS, options.rows ?? ROWS);
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
      ...options.env,
    },
  });
  const run = { process: started, pty };
  live.push(run);
  // The parent's copy of the slave, released as soon as the child has its own.
  // Standard practice for a pseudo-terminal, and load-bearing here: a suite that
  // opens one per interactive run leaks a descriptor pair per run without it, and
  // the master is left holding a writer that never goes away. The master itself
  // stays open — the reader owns it until `close()`.
  try {
    closeSync(pty.slave);
  } catch {
    // Already released. Harmless, and not worth failing a run over.
  }

  await Bun.sleep(MOUNT_MS);

  let read = pty.transcript().length;
  /** Waits until the interface stops drawing, and returns what this step drew. */
  const drawn = async (): Promise<string> => {
    const deadline = Bun.nanoseconds() + STEP_TIMEOUT_MS * 1_000_000;
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
      if (Bun.nanoseconds() - quietSince >= QUIET_MS * 1_000_000) {
        break;
      }
    }
    const whole = pty.transcript();
    const step = whole.slice(read);
    read = whole.length;
    return step;
  };

  // Everything the mount itself drew, consumed before the first step. Without
  // this the first step's slice carries the last frame of the *previous* state,
  // and an assertion that the arrangement changed reads both and passes on the
  // wrong one.
  await drawn();

  await act({
    process: started,
    pty,
    async press(bytes) {
      writeSync(
        pty.master,
        Buffer.from(typeof bytes === "string" ? bytes : Uint8Array.from(bytes)),
      );
      return await drawn();
    },
    async resize(columns, rows) {
      const stty = Bun.spawn(["stty", "rows", String(rows), "columns", String(columns)], {
        stdin: pty.master,
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await stty.exited) !== 0) {
        throw new Error(`stty could not resize the terminal to ${columns}x${rows}`);
      }
      // The kernel signals the foreground process group of a *controlling*
      // terminal, and a spawned child has none — `setsid` plus `TIOCSCTTY` is
      // the other half of what a terminal emulator does, and `TIOCSCTTY` is an
      // `ioctl`. The size is genuinely changed above; this delivers the
      // notification the kernel would have.
      started.kill("SIGWINCH");
      return await drawn();
    },
  });

  const exitCode = await Promise.race([
    started.exited,
    Bun.sleep(EXIT_MS).then(() => "timed-out" as const),
  ]);
  // The bytes written on the way out arrive after the process has gone.
  await Bun.sleep(200);
  return { exitCode, transcript: pty.transcript() };
}

/**
 * Grouped by the path a run exercises, not one run per assertion.
 *
 * Each run costs a pseudo-terminal, a compiled process, and several seconds of a
 * native renderer starting, so five spawns of the same interrupt path tell us
 * nothing extra and make the file flaky. The shared run below exercises the
 * one interactive configuration users can receive.
 */
describe.if(runnable)("the compiled shell on a real terminal", () => {
  /**
   * The interrupt run, started once and read by the four checks below.
   *
   * Lazily, and that is not a micro-optimisation: `describe.if(false)` still
   * evaluates its body, so starting the run here eagerly spawned the executable
   * even on a host that has none — which surfaced as an unhandled `ENOENT`
   * beside the skip notice, in the one case this file exists to report cleanly.
   */
  let started: Promise<ShellRun> | null = null;
  const interrupted = (): Promise<ShellRun> => {
    started ??= runOnPty([], ({ process: child }) => child.kill("SIGINT"));
    return started;
  };

  test(
    "opens an interface and lays it out against the terminal it was given",
    async () => {
      const run = await interrupted();
      // The frame, on a real terminal, uses the full alternate-screen viewport.
      expect(run.transcript).toContain("\u001b[?1049h");
      expect(run.transcript).toContain("workspace");
      // A fact in its `unavailable` state, in words. Short enough to survive the
      // header's per-field share at this width, which "no session yet" is not —
      // that one arrives truncated with the theme's mark, which is itself the
      // measured-width contract working.
      expect(run.transcript).toContain("no Git yet");
      expect(run.transcript).toContain("^C");
      // 256-colour escapes, not 24-bit: `TERM=xterm-256color` says what this
      // terminal has, and the palette was lowered to it rather than emitted at
      // full depth and left for the terminal to reinterpret.
      expect(run.transcript).toContain("38;5;");
      expect(run.transcript).not.toContain("38;2;");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "draws the transcript's empty state rather than a placeholder",
    async () => {
      const run = await interrupted();
      // The primary region on the shipped binary. Before #355 this said
      // "Nothing is running yet." — filler that named no action. The empty state
      // that replaced it points at a command the running build actually has, and
      // asserting it here rather than only through the test renderer is what
      // proves the surface reached the compiled artifact at all.
      expect(run.transcript).toContain("Nothing has happened in this session yet");
      expect(run.transcript).not.toContain("Nothing is running yet");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "draws each region into rows no other region has",
    async () => {
      // #384. Byte assertions cannot say which row a string landed on. The
      // headless emulator can, and this is the invariant the in-memory height
      // sweep already asserts — now against what the shipped artifact emitted.
      let step = "";
      const run = await runOnPty([], async (driver) => {
        // A focus move redraws without changing the region ownership of any
        // landmark, so the settled frame is the empty shell's ordinary layout.
        step = await driver.press([0x09]);
        await driver.press([0x03]);
      });
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      const screen = await emulateScreen(settledFrame(step), {
        columns: COLUMNS,
        rows: ROWS,
      });
      expect(screen.rows).toHaveLength(ROWS);
      // Exclusive landmarks for the header, primary region, and status line at
      // this size. A spliced row is the defect #385 records by hand.
      const mixed = rowsCarryingMarksFromMultipleGroups(screen.rows, [
        ["workspace"],
        ["Nothing has happened"],
        ["^C"],
      ]);
      expect(mixed).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "keeps the activity rail and status line on exclusive rows at the observed shape",
    async () => {
      // #385. The hand observation was 157×70 on Ghostty under the removed
      // split-footer path. The alternate-screen shell is requalified here at
      // that shape and the widths either side of it: exclusive landmarks must
      // not share a row once the transcript has been through the emulator.
      for (const columns of [140, 157, 170]) {
        let step = "";
        const run = await runOnPty(
          [],
          async (driver) => {
            step = await driver.press([0x09]);
            await driver.press([0x03]);
          },
          { columns, rows: 70 },
        );
        expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
        const screen = await emulateScreen(settledFrame(step), { columns, rows: 70 });
        expect(screen.rows).toHaveLength(70);
        const mixed = rowsCarryingMarksFromMultipleGroups(screen.rows, [
          ["Activity"],
          ["Nothing has happened"],
          ["No runtime is attached"],
        ]);
        expect({ columns, mixed }).toEqual({ columns, mixed: [] });
      }
    },
    RUN_TIMEOUT_MS * 3,
  );

  test(
    "takes an interrupt through Falryn's own governance and exits 130",
    async () => {
      const run = await interrupted();
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
      const run = await interrupted();
      // Asserted on the bytes the terminal received rather than on anything the
      // program said about itself. This is the failure that leaves a user
      // closing their window, and it is invisible to every other check here.
      expectRestored(run);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "opens the full-screen shell on a compact terminal",
    async () => {
      // Eight rows is above the 24×6 minimum. No mode fallback is involved:
      // every interactive terminal opens the alternate screen.
      const run = await runOnPty([], ({ process: started }) => started.kill("SIGINT"), {
        columns: 100,
        rows: 8,
      });
      expect(run.exitCode).toBe(EXIT_CODES.CANCELLED);
      expect(run.transcript).not.toContain("could not be started");
      // Content, not merely the absence of the failure. At eight rows the class
      // is compact, so the header's labels are gone and the value is what
      // survives — asserting on "workspace" here would fail for the right
      // behavior. Launch binds the cwd as the primary root, so the header
      // projects that root's display name rather than the pre-set placeholder.
      expect(run.transcript).toContain("falryn");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "exits from the keyboard, and restores the terminal",
    async () => {
      // The defect #26 fixed, on the shipped artifact. A terminal in raw mode
      // has `ISIG` off, so this byte is Ctrl+C arriving as *input* rather than
      // as `SIGINT` — before the keymap existed nothing consumed it, and the
      // only way out of the interface was killing the process from another
      // window while the status line said `^C exit`.
      const run = await runOnPty([], ({ pty }) => {
        writeSync(pty.master, Buffer.from([0x03]));
      });
      // Zero, not 130: this is a deliberate quit, not a cancellation.
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      expectRestored(run);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "opens help, scrolls through the command registry, and closes it",
    async () => {
      // The overlay uses the same full-screen viewport as the shell, so help
      // has room without changing renderer configuration at runtime.
      let opened = "";
      let scrolled = "";
      let closed = "";
      const run = await runOnPty([], async (driver) => {
        opened = await driver.press("?");
        scrolled = await driver.press("\u001b[F");
        closed = await driver.press([0x1b]);
        await driver.press([0x03]);
      });
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      expect(opened).toContain("Help");
      expect(opened).toContain("Ctrl+C ends the session");
      // The focused OpenTUI scrollbox reaches the registry's final command and
      // keeps its unavailability reason visible rather than truncating it away.
      expect(scrolled).toContain("Decline");
      expect(scrolled).toContain("nothing is waiting for confirmation");
      // And closing gives the primary view back. Asserted on what the *step*
      // drew, because the transcript keeps every byte the overlay ever wrote.
      //
      // The panel's own title is the negative, and it was chosen by measuring
      // rather than by reading: `"Close overlay"` is a real command title, and
      // at this height the help list truncates before reaching it — so it is
      // drawn in neither state and a check naming it passes against nothing.
      // The rendered interaction suite uses the same measured negative (#381).
      expect(closed).toContain("Nothing has happened in this session yet");
      expect(closed).not.toContain("Help");
      expectRestored(run);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "opens and closes the command palette",
    async () => {
      // Never exercised on the shipped artifact before. The palette holds a
      // keyboard subscription of its own — #364 — so it is the route where a
      // compiled build losing its input wiring would show up first.
      let opened = "";
      let searched = "";
      let closed = "";
      const run = await runOnPty([], async (driver) => {
        opened = await driver.press([0x10]);
        searched = await driver.press("exit");
        closed = await driver.press([0x1b]);
        await driver.press([0x03]);
      });
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      expect(opened).toContain("Commands");
      // The search field takes characters as text rather than routing them
      // through the command registry, which is the whole of #364.
      expect(searched).toContain("exit");
      expect(closed).toContain("Nothing has happened in this session yet");
      expect(closed).not.toContain("Commands");
      expectRestored(run);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "takes typing into the composer and answers a submission",
    async () => {
      // Input reaching a compiled binary through a real pseudo-terminal is a
      // different path from the mock keyboard: the bytes cross a tty in raw
      // mode, and the composer reads them as text rather than as commands.
      let typed = "";
      let submitted = "";
      const run = await runOnPty([], async (driver) => {
        // Two tabs: header, then the primary region, then the composer.
        await driver.press([0x09]);
        await driver.press([0x09]);
        typed = await driver.press("hello");
        submitted = await driver.press([0x0d]);
        await driver.press([0x03]);
      });
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      expect(typed).toContain("hello");
      // Submission has no consumer until a product port is attached (#707) and
      // says so. Silently discarding what was typed is the failure.
      expect(submitted).toContain("Not sent");
      expect(submitted).toContain("#707");
      expectRestored(run);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "puts the cursor on the row it drew the text on",
    async () => {
      // The check #399 exists for, and the one no frame-level check can make.
      //
      // The composer drew its own rows and then re-derived where the cursor
      // belonged, from a box origin and a width sum. `setCursorPosition` is
      // one-based and those coordinates were zero-based, so the cursor sat one
      // row above the draft and one cell short of the text — on a real terminal
      // only. Every in-memory check agreed with it, because they compared the
      // code's own coordinates against fixtures built from the same assumption.
      //
      // A terminal draws text by moving the cursor and then writing, so the
      // transcript carries the answer: the cursor-position sequence immediately
      // before the typed run says which row the text went to, and the last one
      // of the step says where the cursor was left. They have to be the same
      // row. Nothing here computes a coordinate — both numbers are read from
      // what the terminal received.
      //
      // Validated by reintroducing the defect, and the first attempt did not
      // reproduce it: placing the cursor by hand *beside* the renderable still
      // passes, because the renderable places it again afterwards and the last
      // sequence is its correct one. The faithful mutant is the historical
      // shape — the renderable's own cursor suppressed with `showCursor` and
      // Falryn writing a zero-based coordinate — and that one fails here. Worth
      // stating so that a later simplification of this check has to answer the
      // same question.
      let typed = "";
      const run = await runOnPty([], async (driver) => {
        await driver.press([0x09]);
        await driver.press([0x09]);
        typed = await driver.press("hello");
        await driver.press([0x03]);
      });
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);

      // Built rather than written as a literal: the control character belongs in
      // an escape sequence, and a raw one in source is what `src/source-text.test.ts`
      // exists to refuse.
      const cursorPosition = new RegExp(`${CSI}(\\d+);(\\d+)H`, "g");
      const positions = [...typed.matchAll(cursorPosition)];
      const drawn = positions.filter((match) => {
        const at = (match.index ?? 0) + match[0].length;
        return typed.slice(at, at + 40).includes("hello");
      });
      const wrote = drawn[drawn.length - 1];
      const left = positions[positions.length - 1];
      expect({ wroteText: wrote !== undefined, leftCursor: left !== undefined }).toEqual({
        wroteText: true,
        leftCursor: true,
      });
      expect({ row: left?.[1] }).toEqual({ row: wrote?.[1] });

      // The column, which is the half of the defect the row alone would miss:
      // the historical cursor sat one row above *and* one cell short, and a
      // check that only compared rows would have passed on a cursor sitting
      // inside the word.
      //
      // Derived from the same two sequences rather than from a layout constant.
      // The write began at `wrote`'s column, `hello` starts some plain
      // characters into it, and after drawing five cells the cursor belongs
      // five further along. The offset is only meaningful if nothing between
      // moved the cursor itself. Colour is the one thing that legitimately sits
      // there — the draft is drawn in a theme colour, so a select-graphic
      // sequence precedes the text and occupies no cell. Those are removed, and
      // any other escape refuses rather than quietly comparing arithmetic
      // against a sequence this did not model.
      const wroteAt = (wrote?.index ?? 0) + (wrote?.[0].length ?? 0);
      const before = typed.slice(wroteAt, typed.indexOf("hello", wroteAt));
      const painted = before.replaceAll(new RegExp(`${CSI}[\\d;]*m`, "g"), "");
      expect({ onlyColourBetween: painted.includes(ESC) }).toEqual({
        onlyColourBetween: false,
      });
      expect({ column: Number(left?.[2]) }).toEqual({
        column: Number(wrote?.[2]) + painted.length + "hello".length,
      });
    },
    RUN_TIMEOUT_MS,
  );

  test.if(resizable)(
    "re-lays out when the terminal is resized under it",
    async () => {
      // The row a fixed-size pseudo-terminal cannot cover. The size is changed
      // for real — `stty` reaches `TIOCSWINSZ` — and the shell is expected to
      // draw a *different* arrangement, not merely to survive: at 44 columns the
      // class is compact, and compact drops the header's labels for its values.
      let narrow = "";
      let wide = "";
      const run = await runOnPty([], async (driver) => {
        narrow = await driver.resize(44, 14);
        wide = await driver.resize(COLUMNS, ROWS);
        await driver.press([0x03]);
      });
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      // The frame it settled on, not the transition: a resize repaints at the
      // old size before re-laying out at the new one, so the step carries both.
      expect(settledFrame(narrow)).not.toContain("workspace");
      expect(settledFrame(narrow)).toContain("falryn");
      // And back: the arrangement follows the terminal rather than latching.
      expect(settledFrame(wide)).toContain("workspace");
      expectRestored(run);
    },
    RUN_TIMEOUT_MS,
  );

  // Reported as skipped rather than as an empty passing check, which is the
  // same rule the whole-file fallback below follows: a row that could not run
  // is unqualified, and a green tick is the one thing it must not look like.
  if (!resizable) {
    test.skip("was not resized, because this platform has no usable stty on a pseudo-terminal", () => {
      // Recorded rather than absent. The row is unqualified on this host.
    });
  }

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
