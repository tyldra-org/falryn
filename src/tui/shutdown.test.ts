/**
 * The `restore-terminal` participant.
 *
 * `restore-terminal` was the last declared phase with no owner, and the reason
 * that mattered is the path nobody exercises by hand: an escalated interrupt
 * returns from no command and flushes no stream, so the participant is the only
 * thing that gives the terminal back on it. These tests run the real coordinator
 * rather than calling the participant directly, because what is under test is
 * that the phase actually reaches it.
 */

import { describe, expect, test } from "bun:test";
import { createShutdownCoordinator } from "../application/index.ts";
import { createManualClock, SHUTDOWN_PHASES } from "../domain/index.ts";
import { nothingToRestore, type RestorableTerminal } from "./renderer-session.ts";
import { createTerminalShutdownParticipant, TERMINAL_RESTORE_PARTICIPANT } from "./shutdown.ts";

/** A terminal that records what was asked of it, and can be told to fail. */
function recordingTerminal(failure: string | null = null): RestorableTerminal & {
  calls(): number;
} {
  let calls = 0;
  let restored = false;
  return {
    calls: () => calls,
    isRestored: () => restored,
    restore() {
      calls += 1;
      const restoredNow = !restored;
      restored = true;
      return { modes: ["raw-input" as const], restoredNow, failure };
    },
  };
}

describe("the phase", () => {
  test("is the last one, so nothing still has something to say", () => {
    // Giving the terminal back is the cheapest thing shutdown does, which makes
    // running it first tempting and wrong: a participant in an earlier phase
    // that needs to report a failure would be reporting it into a torn frame.
    expect(SHUTDOWN_PHASES.at(-1)).toBe("restore-terminal");
  });

  test("has a participant, which it did not before", () => {
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    const terminal = recordingTerminal();
    expect(coordinator.register(createTerminalShutdownParticipant(terminal)).ok).toBe(true);
    expect(coordinator.registeredParticipants()).toEqual([
      { name: TERMINAL_RESTORE_PARTICIPANT, phase: "restore-terminal" },
    ]);
  });
});

describe("a shutdown sequence", () => {
  test("restores the terminal", async () => {
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    const terminal = recordingTerminal();
    coordinator.register(createTerminalShutdownParticipant(terminal));

    const report = await coordinator.shutdown();
    expect(terminal.isRestored()).toBe(true);
    expect(report.unfinished).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.outcome.kind).toBe("completed");
  });

  test("restores it under every level, because a shorter grace is still a grace", async () => {
    // Escalation shortens the grace; it never skips a phase. A forced shutdown
    // that abandoned restoration would leave the terminal broken exactly when
    // the user was pressing Ctrl+C repeatedly to get out.
    for (const level of ["graceful", "escalated", "forced"] as const) {
      const coordinator = createShutdownCoordinator({ clock: createManualClock() });
      const terminal = recordingTerminal();
      coordinator.register(createTerminalShutdownParticipant(terminal));
      await coordinator.shutdown({ level });
      expect({ level, restored: terminal.isRestored() }).toEqual({ level, restored: true });
    }
  });

  test("reports a restoration that could not finish rather than calling it clean", async () => {
    // A `destroy()` that threw may have left a mode enabled. A shutdown that
    // reported completed over it would tell the user everything was fine while
    // their terminal was not.
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    coordinator.register(createTerminalShutdownParticipant(recordingTerminal("the tty went away")));

    const report = await coordinator.shutdown();
    expect(report.failures.map((failure) => failure.name)).toEqual([TERMINAL_RESTORE_PARTICIPANT]);
    expect(report.failures[0]?.failure).toContain("the tty went away");
  });

  test("asks a terminal that never opened, and gets a clean answer", async () => {
    // The failure path registers a participant like every other path does, so
    // the phase is never simply absent on the run where the terminal is most
    // likely already half-configured.
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    const terminal = nothingToRestore();
    coordinator.register(createTerminalShutdownParticipant(terminal));

    const report = await coordinator.shutdown();
    expect(terminal.isRestored()).toBe(true);
    expect(report.failures).toEqual([]);
  });

  test("is safe over a terminal the shell already restored on its own way out", async () => {
    // Both happen, and frequently at the same time: the shell restores when it
    // returns, and the coordinator restores because an interrupt started a
    // sequence. The second call must change nothing and fail nothing.
    const coordinator = createShutdownCoordinator({ clock: createManualClock() });
    const terminal = recordingTerminal();
    coordinator.register(createTerminalShutdownParticipant(terminal));
    terminal.restore();

    const report = await coordinator.shutdown();
    expect(terminal.calls()).toBe(2);
    expect(report.failures).toEqual([]);
    expect(report.outcome.kind).toBe("completed");
  });
});
