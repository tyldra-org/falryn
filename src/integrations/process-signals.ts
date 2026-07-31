/**
 * The host process-signal adapter.
 *
 * A leaf: it translates platform signal names into Falryn's `InterruptSignal`
 * and nothing else. No policy, no escalation, no knowledge of scopes — those
 * live in the application layer and must stay testable without a real process.
 *
 * `SIGKILL` is deliberately absent. It cannot be observed, so pretending to
 * handle it would let the runtime claim cleanup it never got to run.
 */

import type { InterruptSignal, SignalPort, Unsubscribe } from "../domain/index.ts";

/** Platform signal to Falryn signal. Extending this is a deliberate contract change. */
const SIGNAL_NAMES = {
  SIGINT: "interrupt",
  SIGTERM: "terminate",
  SIGHUP: "hangup",
} as const satisfies Readonly<Record<string, InterruptSignal>>;

type PlatformSignal = keyof typeof SIGNAL_NAMES;

const PLATFORM_SIGNALS = Object.keys(SIGNAL_NAMES) as PlatformSignal[];

/**
 * Subscribes to host interruption.
 *
 * Each returned unsubscribe removes only its own listeners, so two independent
 * subscribers do not detach each other. Every subscription must be released:
 * an attached listener keeps the process alive.
 */
export function createProcessSignalPort(): SignalPort {
  return {
    onInterrupt(listener: (signal: InterruptSignal) => void): Unsubscribe {
      const installed = PLATFORM_SIGNALS.map((platformSignal) => {
        const handler = (): void => listener(SIGNAL_NAMES[platformSignal]);
        process.on(platformSignal, handler);
        return { platformSignal, handler };
      });

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        for (const { platformSignal, handler } of installed) {
          process.off(platformSignal, handler);
        }
      };
    },
  };
}

/** The platform signals this adapter observes, for diagnostics and tests. */
export function observedPlatformSignals(): readonly string[] {
  return [...PLATFORM_SIGNALS];
}
