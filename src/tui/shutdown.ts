/**
 * The `restore-terminal` participant.
 *
 * `restore-terminal` is the last phase in `SHUTDOWN_PHASES` and had no
 * participant until now — the phase was declared before its owner existed, and
 * `CURRENT-STATE.md` recorded it as missing rather than pretending otherwise.
 * This module is that owner.
 *
 * It runs last for a reason that is easy to get backwards: giving the terminal
 * back is the *cheapest* thing shutdown does, so putting it first would be
 * tempting. But a participant in an earlier phase that needs to say something —
 * a storage failure, an unfinished drain — needs somewhere to say it, and a
 * terminal already handed back mid-sequence would swallow it into a torn frame.
 * The terminal is released once nothing else is going to speak.
 *
 * The participant does no work of its own. Restoration is idempotent and lives
 * with the session; this is the registration that makes the interrupt path, the
 * deadline path, and the crash path converge on the same call the clean path
 * already makes.
 */

import type { ShutdownParticipant } from "../domain/index.ts";
import type { RestorableTerminal } from "./renderer-session.ts";

/** Stable across builds: a shutdown report names unfinished participants by it. */
export const TERMINAL_RESTORE_PARTICIPANT = "terminal-restore";

export function createTerminalShutdownParticipant(
  terminal: RestorableTerminal,
): ShutdownParticipant {
  return {
    name: TERMINAL_RESTORE_PARTICIPANT,
    phase: "restore-terminal",
    async run() {
      const report = terminal.restore();
      if (report.failure !== null) {
        // Reported rather than swallowed. A restoration that threw may have left
        // a mode enabled, and a shutdown that called that completed would tell
        // the user everything was fine while their terminal was not.
        throw new Error(`the terminal was not fully restored: ${report.failure}`);
      }
    },
  };
}
