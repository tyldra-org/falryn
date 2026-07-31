/**
 * Process interruption, as the runtime sees it.
 *
 * The port exists so the interruption policy and the shutdown coordinator never
 * touch `process`. It reports *that* an interrupt arrived, not what the host
 * called it, which keeps escalation policy independent of platform signal
 * naming.
 */

export const INTERRUPT_SIGNALS = ["interrupt", "terminate", "hangup"] as const;

export type InterruptSignal = (typeof INTERRUPT_SIGNALS)[number];

/** Removes a subscription. Calling it more than once is safe. */
export type Unsubscribe = () => void;

export type SignalPort = {
  /**
   * Subscribes to host interruption.
   *
   * Listeners are called in subscription order. The returned function must be
   * called during shutdown, or the host keeps the process alive on behalf of a
   * subscription nobody is listening to any more.
   */
  onInterrupt(listener: (signal: InterruptSignal) => void): Unsubscribe;
};

export type ManualSignalPort = SignalPort & {
  /** Delivers a signal to every current subscriber. */
  emit(signal: InterruptSignal): void;
  subscriberCount(): number;
};

/** An in-memory `SignalPort` for tests. Delivers only what a test emits. */
export function createManualSignalPort(): ManualSignalPort {
  let listeners: ((signal: InterruptSignal) => void)[] = [];

  return {
    onInterrupt(listener): Unsubscribe {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    },
    emit(signal: InterruptSignal): void {
      for (const listener of [...listeners]) {
        listener(signal);
      }
    },
    subscriberCount(): number {
      return listeners.length;
    },
  };
}
