/**
 * Cancellation scope contracts.
 *
 * A scope is the unit that can be stopped. Scopes nest along the runtime's
 * ownership chain — application → session → turn → attempt → invocation →
 * child — and cancellation travels downward only. Nothing propagates upward,
 * because a cancelled child must not stop its siblings or its parent.
 *
 * The rule this module exists to protect: **completion does not erase partial
 * effects.** A scope's recorded effect only ever becomes more uncertain, so a
 * scope that mutated something and then finished still reports that it mutated
 * something.
 */

import type { Instant } from "./clock.ts";
import type { Deadline } from "./deadline.ts";
import type { ScopeId } from "./identity.ts";
import type { EffectCertainty, TerminalOutcome } from "./outcome.ts";

export const SCOPE_KINDS = [
  "application",
  "session",
  "turn",
  "attempt",
  "invocation",
  "child",
] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

export function isScopeKind(value: unknown): value is ScopeKind {
  return typeof value === "string" && (SCOPE_KINDS as readonly string[]).includes(value);
}

/**
 * Why a scope is stopping.
 *
 * Deadline expiry records whether escalation occurred, because a deadline that
 * was escalated past is a materially different fact from one that expired while
 * the work was still co-operating.
 */
export type CancellationReason =
  /** A user or caller asked for it. */
  | { readonly kind: "requested" }
  /** An ancestor was cancelled. Names which one, so the origin stays traceable. */
  | { readonly kind: "parent-cancelled"; readonly originScopeId: ScopeId }
  | {
      readonly kind: "deadline-exceeded";
      readonly deadline: Deadline;
      readonly escalated: boolean;
    }
  /** The process is shutting down. */
  | { readonly kind: "shutdown" };

export const SCOPE_STATUSES = ["active", "cancelling", "terminal"] as const;

export type ScopeStatus = (typeof SCOPE_STATUSES)[number];

/**
 * `cancelling` is deliberately observable.
 *
 * Without it the runtime could only show "running" or "stopped", and a slow
 * drain would look like a freeze. A scope stays `cancelling` until its work
 * acknowledges, which is what lets a surface show draining or escalation.
 */
export type ScopeState =
  | { readonly status: "active" }
  | {
      readonly status: "cancelling";
      readonly reason: CancellationReason;
      readonly requestedAt: Instant;
    }
  | {
      readonly status: "terminal";
      readonly outcome: TerminalOutcome;
      readonly reason: CancellationReason | null;
      readonly settledAt: Instant;
    };

export type ScopeEventKind =
  | "scope.opened"
  | "scope.cancellation.requested"
  | "scope.effect.recorded"
  | "scope.terminal";

/**
 * An ordered observation of a scope's lifecycle.
 *
 * These are in-process observations, not durable `RuntimeEvent`s: a scope
 * exists above session identity, so it cannot carry the session correlation the
 * durable envelope requires. Projecting them into durable events belongs to the
 * persistence owner.
 */
export type ScopeEvent = {
  /** Monotonic across the whole tree, so interleaved scopes stay orderable. */
  readonly order: number;
  readonly kind: ScopeEventKind;
  readonly scopeId: ScopeId;
  readonly scopeKind: ScopeKind;
  readonly at: Instant;
  readonly reason: CancellationReason | null;
  readonly outcome: TerminalOutcome | null;
  readonly effect: EffectCertainty | null;
};

export type ScopeReport = {
  readonly scopeId: ScopeId;
  readonly kind: ScopeKind;
  readonly parentId: ScopeId | null;
  readonly state: ScopeState;
  readonly deadline: Deadline | null;
  /** What this scope alone did to the world. */
  readonly recordedEffect: EffectCertainty;
  /** The most uncertain effect anywhere in this scope's subtree, including itself. */
  readonly subtreeEffect: EffectCertainty;
  /** Whether external state must be observed before this work is retried. */
  readonly requiresInspection: boolean;
};

export type ScopeError =
  | { readonly code: "unknown-scope"; readonly scopeId: ScopeId }
  | { readonly code: "duplicate-scope"; readonly scopeId: ScopeId }
  /** A terminal scope cannot gain children, effects, or a second outcome. */
  | { readonly code: "scope-already-terminal"; readonly scopeId: ScopeId }
  | { readonly code: "scope-depth-exceeded"; readonly maximumDepth: number }
  | { readonly code: "scope-count-exceeded"; readonly maximumScopes: number };

/**
 * How much inspection an effect demands, ascending.
 *
 * A scope's effect moves up this scale and never down, which is the mechanism
 * that keeps a completion from erasing a partial mutation.
 */
const EFFECT_SEVERITY: Readonly<Record<EffectCertainty, number>> = {
  none: 0,
  completed: 1,
  partial: 2,
  uncertain: 3,
};

export function effectSeverity(effect: EffectCertainty): number {
  return EFFECT_SEVERITY[effect];
}

/** The more inspection-demanding of two effects. */
export function worstEffect(left: EffectCertainty, right: EffectCertainty): EffectCertainty {
  return effectSeverity(right) > effectSeverity(left) ? right : left;
}

/**
 * The terminal outcome cancellation produces for a scope with this effect.
 *
 * A scope that changed nothing observable is honestly `cancelled`. A scope that
 * had begun changing something is `uncertain`, because nobody observed whether
 * the change landed — and reporting it as merely cancelled would invite a retry
 * that duplicates the effect.
 */
export function cancellationOutcomeFor(effect: EffectCertainty): TerminalOutcome {
  switch (effect) {
    case "none":
      return { kind: "cancelled", effect: "none" };
    case "completed":
      return { kind: "cancelled", effect: "completed" };
    case "partial":
    case "uncertain":
      return { kind: "uncertain", effect: "uncertain" };
  }
}

/** The terminal outcome a deadline expiry produces for a scope with this effect. */
export function timeoutOutcomeFor(effect: EffectCertainty): TerminalOutcome {
  switch (effect) {
    case "none":
      return { kind: "timed-out", effect: "none" };
    case "completed":
      return { kind: "timed-out", effect: "completed" };
    case "partial":
    case "uncertain":
      return { kind: "timed-out", effect: "uncertain" };
  }
}
