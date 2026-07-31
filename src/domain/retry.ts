/**
 * The retry decision contract.
 *
 * `retryable` on an error says a later attempt *may* succeed. This module is
 * what decides whether one actually happens, weighing the effect contract,
 * idempotency, how many attempts have been spent, and how much of the elapsed
 * budget is left.
 *
 * The separation is the point: an error that is retryable in principle must
 * still be refused when the operation is not idempotent and its effect was not
 * observed, because the retry would duplicate it.
 */

import type { DurationMs } from "./clock.ts";
import type { FalrynError } from "./error.ts";
import type { RetryPolicy } from "./work.ts";

export type RetryRefusal =
  /** The error's own contract says a later attempt cannot succeed. */
  | "not-retryable"
  /** The effect began and was not observed; retrying could duplicate it. */
  | "effect-not-observed"
  /** The operation is not idempotent and has no precondition to guard a repeat. */
  | "not-idempotent"
  | "attempts-exhausted"
  | "elapsed-budget-exhausted"
  | "cancelled";

export type RetryDecision =
  | {
      readonly kind: "retry";
      /** The attempt number this delay leads to, counting the first as 1. */
      readonly attempt: number;
      readonly delayMs: DurationMs;
    }
  | { readonly kind: "do-not-retry"; readonly reason: RetryRefusal };

export type RetryBackoff = {
  readonly baseDelayMs: number;
  /** Delay never exceeds this, however many attempts have been made. */
  readonly maxDelayMs: number;
  /**
   * Fraction of the computed delay that jitter may add, from 0 to 1.
   *
   * Jitter exists so a fleet of clients that failed together does not retry
   * together; without it, backoff synchronizes the very load it is spreading.
   */
  readonly jitterRatio: number;
};

export const DEFAULT_RETRY_BACKOFF: RetryBackoff = {
  baseDelayMs: 100,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
};

export type RetryRequest = {
  readonly error: FalrynError;
  readonly policy: RetryPolicy;
  /** Attempts already made, including the one that just failed. */
  readonly attemptsMade: number;
  /** Time already spent on this operation across all attempts. */
  readonly elapsedMs: number;
  /** Total time the operation may spend, or `null` for no limit. */
  readonly elapsedBudgetMs: number | null;
  /**
   * Whether repeating the operation is safe on its own terms.
   *
   * Declared by the caller because only it knows whether the operation has a
   * precondition — an `If-Match`, a unique key — that makes a repeat safe.
   */
  readonly idempotent: boolean;
  readonly cancelled: boolean;
  readonly backoff?: RetryBackoff;
  /**
   * Returns a fraction in `[0, 1)` used to spread the delay.
   *
   * Injected so a test can make backoff deterministic without the module
   * reaching for a global random source.
   */
  readonly jitter?: () => number;
};

/**
 * Exponential backoff, capped, with jitter added on top of the capped value.
 *
 * The cap is applied before jitter so the ceiling stays a real ceiling rather
 * than one the jitter can exceed.
 */
export function backoffDelayMs(attempt: number, backoff: RetryBackoff, jitter: number): DurationMs {
  const exponential = backoff.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, backoff.maxDelayMs);
  const spread = Math.floor(capped * backoff.jitterRatio * Math.min(Math.max(jitter, 0), 1));
  return Math.max(0, Math.floor(capped) + spread) as DurationMs;
}

/**
 * Decides whether to retry.
 *
 * Refusals are checked cheapest and most decisive first, so the reported reason
 * is the one a caller can actually act on.
 */
export function evaluateRetry(request: RetryRequest): RetryDecision {
  if (request.cancelled) {
    return { kind: "do-not-retry", reason: "cancelled" };
  }
  if (!request.error.retryable || !request.policy.retryable) {
    return { kind: "do-not-retry", reason: "not-retryable" };
  }
  if (request.error.effect === "uncertain" || request.error.effect === "partial") {
    return { kind: "do-not-retry", reason: "effect-not-observed" };
  }
  if (!request.idempotent && request.error.effect !== "none") {
    return { kind: "do-not-retry", reason: "not-idempotent" };
  }
  if (request.attemptsMade >= request.policy.maxAttempts) {
    return { kind: "do-not-retry", reason: "attempts-exhausted" };
  }
  if (request.elapsedBudgetMs !== null && request.elapsedMs >= request.elapsedBudgetMs) {
    return { kind: "do-not-retry", reason: "elapsed-budget-exhausted" };
  }

  const backoff = request.backoff ?? DEFAULT_RETRY_BACKOFF;
  const jitter = request.jitter?.() ?? 0;
  return {
    kind: "retry",
    attempt: request.attemptsMade + 1,
    delayMs: backoffDelayMs(request.attemptsMade, backoff, jitter),
  };
}
