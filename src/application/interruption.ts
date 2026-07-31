/**
 * Interruption escalation policy.
 *
 * The first interrupt asks; the second insists; the third stops waiting. Each
 * step shortens how long cleanup is given — it never skips cleanup, because the
 * only thing worse than a slow exit is an exit that reports success for work it
 * never observed finishing.
 *
 * The ladder is `ShutdownLevel`, deliberately the same one the shutdown
 * coordinator uses. A second, parallel notion of "how urgent is this" would let
 * the two disagree about whether cleanup still has time.
 */

import type {
  ClockPort,
  Instant,
  InterruptSignal,
  ShutdownLevel,
  SignalPort,
  Unsubscribe,
} from "../domain/index.ts";

export type InterruptionState = {
  readonly level: ShutdownLevel;
  readonly count: number;
  readonly firstAt: Instant | null;
  readonly lastAt: Instant | null;
  readonly lastSignal: InterruptSignal | null;
};

export type InterruptionDecision =
  /** First interrupt: request cooperative cancellation and begin draining. */
  | { readonly action: "request-cancellation"; readonly level: "graceful" }
  /** Repeated interrupt: keep draining, but on a shorter grace. */
  | { readonly action: "escalate"; readonly level: "escalated" }
  /** Further interrupt: settle what has not been observed and stop waiting. */
  | { readonly action: "force"; readonly level: "forced" }
  /** Already forced. Additional interrupts change nothing. */
  | { readonly action: "ignored"; readonly level: "forced" };

export type InterruptionPolicy = {
  /** Records an interrupt and returns what the runtime should now do. */
  interrupt(signal: InterruptSignal): InterruptionDecision;
  state(): InterruptionState;
};

/**
 * Interrupts arriving closer together than this are still counted separately.
 *
 * There is no debounce on purpose: a user pressing the key twice quickly is
 * expressing urgency, and swallowing the second press would make the runtime
 * feel unresponsive at exactly the moment responsiveness matters.
 */
export function createInterruptionPolicy(clock: ClockPort): InterruptionPolicy {
  let level: ShutdownLevel = "graceful";
  let count = 0;
  let firstAt: Instant | null = null;
  let lastAt: Instant | null = null;
  let lastSignal: InterruptSignal | null = null;

  return {
    interrupt(signal: InterruptSignal): InterruptionDecision {
      const at = clock.now();
      count += 1;
      firstAt ??= at;
      lastAt = at;
      lastSignal = signal;

      if (count === 1) {
        level = "graceful";
        return { action: "request-cancellation", level: "graceful" };
      }
      if (count === 2) {
        level = "escalated";
        return { action: "escalate", level: "escalated" };
      }
      if (level === "forced") {
        return { action: "ignored", level: "forced" };
      }
      level = "forced";
      return { action: "force", level: "forced" };
    },

    state(): InterruptionState {
      return { level, count, firstAt, lastAt, lastSignal };
    },
  };
}

/**
 * Connects a `SignalPort` to a policy.
 *
 * Returns the unsubscribe function. Dropping it leaks a host subscription that
 * keeps the process alive, so the caller owns it for the process's lifetime.
 */
export function attachInterruptionPolicy(
  port: SignalPort,
  policy: InterruptionPolicy,
  onDecision: (decision: InterruptionDecision, signal: InterruptSignal) => void,
): Unsubscribe {
  return port.onInterrupt((signal) => {
    onDecision(policy.interrupt(signal), signal);
  });
}
