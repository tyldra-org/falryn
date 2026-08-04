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
 * The terminal itself lives in `./pty-fixtures.ts` — allocated through libc's
 * `openpty`, which is the only way to get a process a real tty without adding a
 * native dependency, and not through `script(1)`, which requires a tty on *its*
 * own stdin and so fails in exactly the non-interactive contexts a test suite
 * runs in. It moved there when `./measurement.test.tsx` needed the same terminal
 * for the two quantities a test renderer cannot answer; a second copy of the
 * descriptor handling and the `SIGWINCH` delivery is a second thing to get
 * subtly wrong.
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

import { describe, expect, test } from "bun:test";
import { EXIT_CODES } from "../cli/index.ts";
import {
  COLUMNS,
  compiledArtifactBuilt,
  compiledShellRunnable,
  RESTORED,
  ROWS,
  resizable,
  runOnPty,
  type ShellRun,
  settledFrame,
  write,
} from "./pty-fixtures.ts";

/** A whole run: a compiled process, a native renderer starting, and its exit. */
const RUN_TIMEOUT_MS = 30_000;

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

describe.if(compiledShellRunnable)("the compiled shell on a real terminal", () => {
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
      // The frame, on a real terminal. The header's labels are the load-bearing
      // half: they only appear when the layout class was selected from the
      // terminal's own size, and in `split-footer` the region the tree is drawn
      // into is six rows — which would have selected compact and dropped them.
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
    "opens the shell on a terminal too short for a footer",
    async () => {
      // The regression #351 was. Below `MIN_SPLIT_FOOTER_ROWS` the mode falls
      // back to `alternate-screen`, which could not construct — so every
      // terminal shorter than ten rows exited 5 instead of drawing anything.
      // Eight rows is above the 24×6 minimum, so a frame is the correct answer.
      const run = await runOnPty([], ({ process: started }) => started.kill("SIGINT"), {
        columns: 100,
        rows: 8,
      });
      expect(run.exitCode).toBe(EXIT_CODES.CANCELLED);
      expect(run.transcript).not.toContain("could not be started");
      // Content, not merely the absence of the failure. At eight rows the class
      // is compact, so the header's labels are gone and the value is what
      // survives — asserting on "workspace" here would fail for the right
      // behavior.
      expect(run.transcript).toContain("current directory");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "opens the shell in every mode the override accepts",
    async () => {
      // `FALRYN_TUI` accepts all three and `reference/CLI.md` documents all
      // three. Two of them were unreachable. Driven through the override rather
      // than through a terminal size because that is the only way to reach
      // `main-screen` at all, which had never been exercised.
      for (const mode of ["alternate-screen", "main-screen"]) {
        const run = await runOnPty([], ({ process: started }) => started.kill("SIGINT"), {
          env: { FALRYN_TUI: mode },
        });
        expect({ mode, code: run.exitCode }).toEqual({ mode, code: EXIT_CODES.CANCELLED });
        expect({ mode, drew: run.transcript.includes("workspace") }).toEqual({ mode, drew: true });
      }
    },
    RUN_TIMEOUT_MS * 2,
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
        write(pty, [0x03]);
      });
      // Zero, not 130: this is a deliberate quit, not a cancellation.
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      expectRestored(run);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "opens help from the keyboard, with every command and its key, and closes it",
    async () => {
      // The overlay grows the footer to make room for itself, so this also
      // proves that: at the default six-row footer the panel would have had one
      // row and the commands would have drawn over each other.
      let opened = "";
      let closed = "";
      const run = await runOnPty([], async (driver) => {
        opened = await driver.press("?");
        closed = await driver.press([0x1b]);
        await driver.press([0x03]);
      });
      expect(run.exitCode).toBe(EXIT_CODES.COMPLETED);
      expect(opened).toContain("Help");
      expect(opened).toContain("ctrl+c");
      // A command that cannot run, listed with its reason rather than hidden.
      // `app.cancel` rather than a composer command: at this terminal height the
      // list truncates before the composer rows, which is the bounded-overlay
      // behavior working rather than a missing entry.
      expect(opened).toContain("nothing is running to cancel");
      // And closing gives the primary view back. Asserted on what the *step*
      // drew, because the transcript keeps every byte the overlay ever wrote.
      //
      // The panel's own title is the negative, and it was chosen by measuring
      // rather than by reading: `"Close overlay"` is a real command title, and
      // at this height the help list truncates before reaching it — so it is
      // drawn in neither state and a check naming it passes against nothing.
      // `../components/interaction.test.tsx` still asserts that way, which is
      // https://github.com/yogeshprasad098/falryn/issues/381 rather than this
      // issue's to correct.
      expect(closed).toContain("workspace");
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
      expect(closed).toContain("workspace");
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
      // Submission has no consumer in v0.1 and says so, with the issue that
      // will give it one. Silently discarding what was typed is the failure.
      expect(submitted).toContain("Not sent");
      expect(submitted).toContain("#33");
      expectRestored(run);
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
      expect(settledFrame(narrow)).toContain("current direct");
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
      expect(run.transcript).toContain(RESTORED.scrollRegionReset);
    },
    RUN_TIMEOUT_MS,
  );
});

describe.if(!compiledShellRunnable)("the compiled shell on a real terminal", () => {
  test.skip(
    compiledArtifactBuilt
      ? "no pseudo-terminal is available on this platform, so the shipped artifact was not exercised"
      : "dist/falryn has not been built, so the shipped artifact was not exercised",
    () => {
      // Reported as skipped rather than silently absent, and never as passed:
      // this is the only check that runs the executable a user actually runs.
    },
  );
});
