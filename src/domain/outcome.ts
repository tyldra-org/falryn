/**
 * Terminal outcomes for runtime work.
 *
 * The union is exhaustive and closed: every turn, model attempt, and
 * capability invocation finishes as exactly one of these. Effect certainty is
 * orthogonal to the outcome — a timed-out request may still have completed
 * remotely — so it is carried as its own field rather than encoded in the
 * outcome name.
 *
 * This module owns the shape only. The behavior that produces `cancelled` and
 * `timed-out` is owned by the cancellation and deadline work, and the behavior
 * that produces `failed` and `uncertain` by the error and recovery work.
 */

import { assertNever } from "./result.ts";

export const TERMINAL_OUTCOME_KINDS = [
  "completed",
  "failed",
  "cancelled",
  "timed-out",
  "uncertain",
] as const;

export type TerminalOutcomeKind = (typeof TERMINAL_OUTCOME_KINDS)[number];

/**
 * Whether the work changed anything outside Falryn.
 *
 * `uncertain` means the effect could not be observed and must be inspected
 * before a retry; it is never downgraded to `none` on the strength of an
 * expectation.
 */
export const EFFECT_CERTAINTIES = ["none", "completed", "partial", "uncertain"] as const;

export type EffectCertainty = (typeof EFFECT_CERTAINTIES)[number];

export type TerminalOutcome =
  /** Finished as requested; the effect is fully applied by definition. */
  | { readonly kind: "completed" }
  /** Ended on a failure. The effect may range from none to uncertain. */
  | { readonly kind: "failed"; readonly effect: EffectCertainty }
  /** Ended because cancellation was requested. Cancellation is control flow, not an error. */
  | { readonly kind: "cancelled"; readonly effect: EffectCertainty }
  /** Ended because a deadline expired. The remote side may still be running. */
  | { readonly kind: "timed-out"; readonly effect: EffectCertainty }
  /** Ended without an observable result. Always carries uncertain effect. */
  | { readonly kind: "uncertain"; readonly effect: "uncertain" };

export function isTerminalOutcomeKind(value: unknown): value is TerminalOutcomeKind {
  return typeof value === "string" && (TERMINAL_OUTCOME_KINDS as readonly string[]).includes(value);
}

/** The effect certainty implied by an outcome, resolving `completed`'s implicit value. */
export function effectOf(outcome: TerminalOutcome): EffectCertainty {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
    case "timed-out":
      return outcome.effect;
    case "uncertain":
      return "uncertain";
    default:
      return assertNever(outcome, "unhandled terminal outcome");
  }
}

/**
 * Whether the workspace or an external system must be inspected before the
 * work is retried.
 */
export function requiresInspection(outcome: TerminalOutcome): boolean {
  const effect = effectOf(outcome);
  return effect === "uncertain" || effect === "partial";
}
