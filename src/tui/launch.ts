/**
 * Whether this terminal can host the shell.
 *
 * A pure function of the capability record and the parsed options, which is the
 * whole design: the decision that governs every interactive run is testable
 * across every combination without a terminal, a renderer, or a native library.
 * It reads facts and returns either a launch or a *named* reason — never a bare
 * boolean, because "it did not start" and "it did not start because stdout is a
 * pipe" are different things to the person reading the output.
 *
 * A refusal is an ordinary answer, not a failure. The invocation keeps the
 * behavior it had before the shell existed and exits the way it always did.
 *
 * This module imports no OpenTUI runtime value, so a run that will not launch
 * loads no native library to find that out.
 */

import type { GlobalOptions } from "../cli/index.ts";
import { hasUsableSize, type ShellCapabilities } from "./capabilities.ts";

/**
 * Every reason the shell does not start.
 *
 * Closed and ordered by the precedence the decision applies, so the reason a
 * run reports is stable rather than dependent on which check happened to run
 * first.
 */
export const NON_LAUNCH_REASONS = [
  /** A format other than `human` was asked for; ANSI never enters a machine stream. */
  "machine-format",
  /** `--non-interactive`: the caller stated there is nobody to interact with. */
  "non-interactive",
  /** The documented override refused it. */
  "unsupported",
  /** stdin is not a terminal, so no key can arrive. */
  "not-a-tty",
  /** stdout or stderr is being captured, so frames would land in a file. */
  "piped-output",
  /** `TERM=dumb`: the terminal said it renders nothing beyond plain text. */
  "dumb-terminal",
  /** The terminal reports no usable width or height. */
  "no-dimensions",
] as const;

export type NonLaunchReason = (typeof NON_LAUNCH_REASONS)[number];

export type LaunchDecision =
  | { readonly kind: "launch"; readonly columns: number; readonly rows: number }
  | { readonly kind: "declined"; readonly reason: NonLaunchReason };

/**
 * Whether to launch, and why not when not.
 *
 * Precedence is the contract, highest first:
 *
 * 1. **What the caller asked for.** `--format json` on a perfect terminal is
 *    still a machine run, and reporting `not-a-tty` for it would send someone
 *    to check a handle that was never the problem.
 * 2. **The documented override**, which exists to be believed over detection.
 * 3. **The handles**, then what the terminal says about itself, then its size.
 *
 * An unrecognized override does not decline: the value said nothing this build
 * understands, and refusing on it would turn a typo into a terminal that cannot
 * run Falryn. The caller reports it and carries on.
 */
export function decideLaunch(
  capabilities: ShellCapabilities,
  options: GlobalOptions,
): LaunchDecision {
  if (options.format !== "human") {
    return declined("machine-format");
  }
  if (options.nonInteractive) {
    return declined("non-interactive");
  }
  if (capabilities.override.kind === "off") {
    return declined("unsupported");
  }

  const { handles } = capabilities;
  if (!handles.stdin.isTty) {
    return declined("not-a-tty");
  }
  // Both output handles, because either one being captured means a frame would
  // be written into something that is not a terminal. stdout carries the frames
  // and stderr carries every diagnostic the shell still has to be able to emit.
  if (!handles.stdout.isTty || !handles.stderr.isTty) {
    return declined("piped-output");
  }
  if (capabilities.hints.dumbTerminal) {
    return declined("dumb-terminal");
  }
  if (!hasUsableSize(capabilities) || capabilities.columns === null || capabilities.rows === null) {
    // Checked rather than defaulted. A terminal reporting nothing is not an
    // 80x24 terminal, and every layout decision taken from a substituted size
    // would be wrong in a way nobody could see.
    return declined("no-dimensions");
  }

  return { kind: "launch", columns: capabilities.columns, rows: capabilities.rows };
}

function declined(reason: NonLaunchReason): LaunchDecision {
  return { kind: "declined", reason };
}

/**
 * What to tell someone whose run did not open the shell.
 *
 * One sentence per reason, naming the observation rather than the check. It
 * goes to the diagnostic handle: the shell not opening is a notice about the
 * run, and stdout carries the selected result format and nothing else.
 */
export function nonLaunchNotice(reason: NonLaunchReason): string {
  switch (reason) {
    case "machine-format":
      return "The interactive shell needs --format human; showing help instead.";
    case "non-interactive":
      return "The interactive shell was skipped because --non-interactive was requested.";
    case "unsupported":
      return "The interactive shell was refused by FALRYN_TUI; showing help instead.";
    case "not-a-tty":
      return "The interactive shell needs a terminal on standard input; showing help instead.";
    case "piped-output":
      return "The interactive shell needs a terminal on standard output and error; showing help instead.";
    case "dumb-terminal":
      return "The interactive shell needs more than TERM=dumb can render; showing help instead.";
    case "no-dimensions":
      return "The interactive shell needs a terminal that reports its size; showing help instead.";
  }
}
