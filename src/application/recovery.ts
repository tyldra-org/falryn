/**
 * The runtime recovery catalog.
 *
 * Each action states what it may change and what has to be true first. The rule
 * that shapes all of them: **after uncertainty, observe before acting.** Falryn
 * does not retry, roll back, or report completion because an operation was
 * expected to behave a certain way — only because someone looked.
 *
 * The catalog is scoped to actions the runtime owns. Reauthenticating,
 * reconnecting a managed service, freeing storage, and building a support
 * bundle belong to the owners of those subsystems.
 */

import {
  addDuration,
  type ClockPort,
  duration,
  evaluateRetry,
  type FalrynError,
  type RecoveryAction,
  type RetryDecision,
  type RetryRequest,
} from "../domain/index.ts";

export type RecoveryDescription = {
  readonly action: RecoveryAction;
  /** What running it may change. `null` when it changes nothing observable. */
  readonly effects: string | null;
  /** What has to hold before it is safe to run. */
  readonly prerequisite: string;
};

const CATALOG: Readonly<Record<RecoveryAction, RecoveryDescription>> = {
  retry: {
    action: "retry",
    effects: "May repeat the operation's effect if the first attempt partly applied.",
    prerequisite:
      "The effect is observed as none or completed, and the retry policy permits another attempt.",
  },
  "re-read-stale-evidence": {
    action: "re-read-stale-evidence",
    effects: null,
    prerequisite: "The evidence has a source that can be read again.",
  },
  "inspect-state": {
    action: "inspect-state",
    effects: null,
    prerequisite: "None. This is always safe and is the first step after uncertainty.",
  },
  "reset-scoped-state": {
    action: "reset-scoped-state",
    effects: "Discards the named scope's in-memory state. Durable data is untouched.",
    prerequisite: "The scope is terminal and nothing is still reading it.",
  },
};

export function describeRecovery(action: RecoveryAction): RecoveryDescription {
  return CATALOG[action];
}

export function recoveryPlan(error: FalrynError): readonly RecoveryDescription[] {
  return error.recovery.map(describeRecovery);
}

/**
 * Whether the runtime may act on an error before observing external state.
 *
 * `partial` and `uncertain` both mean something happened that nobody watched
 * finish, so both require inspection first regardless of retryability.
 */
export function requiresObservationFirst(error: FalrynError): boolean {
  return error.effect === "partial" || error.effect === "uncertain";
}

export type ObservationResult<State> = {
  /** What the world actually looks like now. */
  readonly observed: State;
  readonly at: ReturnType<ClockPort["now"]>;
};

export type RecoveryStep =
  /** Nothing may be done until the caller's observer has reported. */
  | { readonly kind: "observe-first"; readonly reason: "effect-not-observed" }
  | { readonly kind: "retry"; readonly decision: RetryDecision }
  | { readonly kind: "do-not-retry"; readonly decision: RetryDecision }
  | { readonly kind: "no-recovery"; readonly reason: "no-runtime-action-applies" };

/**
 * Chooses the next recovery step.
 *
 * Observation is checked before the retry policy, not after: asking "may I
 * retry?" about an effect nobody has looked at is the wrong question, and
 * answering it would let a plausible retry duplicate a mutation.
 */
export function planRecovery<State>(
  error: FalrynError,
  request: RetryRequest,
  observation: ObservationResult<State> | null,
): RecoveryStep {
  if (requiresObservationFirst(error) && observation === null) {
    return { kind: "observe-first", reason: "effect-not-observed" };
  }
  const decision = evaluateRetry(request);
  if (decision.kind === "retry") {
    return { kind: "retry", decision };
  }
  return error.recovery.length === 0
    ? { kind: "no-recovery", reason: "no-runtime-action-applies" }
    : { kind: "do-not-retry", decision };
}

export type BackoffOutcome = "elapsed" | "cancelled";

/**
 * Waits out a retry delay.
 *
 * Cancellable, and resolved through `ClockPort` so a caller can observe the
 * wait without one passing in real time.
 */
export async function awaitBackoff(
  clock: ClockPort,
  decision: RetryDecision,
  signal?: AbortSignal,
): Promise<BackoffOutcome> {
  if (decision.kind !== "retry") {
    return "elapsed";
  }
  if (signal?.aborted === true) {
    return "cancelled";
  }
  const waited = await clock.waitUntil(
    addDuration(clock.now(), duration(decision.delayMs)),
    signal,
  );
  return waited === "reached" ? "elapsed" : "cancelled";
}
