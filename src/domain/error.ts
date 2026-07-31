/**
 * The runtime's failure contract.
 *
 * One shape describes every failure, with each fact in its own field:
 * retryability, effect certainty, user-safe message, developer cause,
 * correlation, and recovery are independent. Collapsing any two of them is how
 * a caller ends up retrying something that already half-happened.
 *
 * Two rules the type enforces rather than documents:
 *
 * - **`effect` is orthogonal to the category.** A cancellation can carry a
 *   completed effect and a provider failure can carry an uncertain one.
 * - **An unrecognized code is preserved, never reinterpreted.** Adopting an
 *   error from a newer build marks it `recognized: false` and keeps what it
 *   said, rather than mapping it onto a known category that means something
 *   else.
 *
 * Codes are not stable at v0.1. Nothing here assigns a published code.
 */

import type {
  CapabilityId,
  EventId,
  InvocationId,
  ScopeId,
  SessionId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./identity.ts";
import type { EffectCertainty } from "./outcome.ts";

/** The canonical category vocabulary. Later owners attach to it, never extend it locally. */
export const ERROR_CATEGORIES = [
  "bootstrap",
  "configuration",
  "authentication",
  "provider",
  "context",
  "tool",
  "workspace",
  "process",
  "integration",
  "data",
  "cancellation",
  "internal",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export function isErrorCategory(value: unknown): value is ErrorCategory {
  return typeof value === "string" && (ERROR_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The categories the v0.1 runtime can actually produce.
 *
 * The rest of the vocabulary is declared so later owners attach to it; emitting
 * one of them today would be a claim about behavior that does not exist.
 */
export const RUNTIME_EMITTED_CATEGORIES = ["data", "cancellation", "internal"] as const;

export type RuntimeEmittedCategory = (typeof RUNTIME_EMITTED_CATEGORIES)[number];

/** Runtime-owned recovery. Each names what it may change and what it needs first. */
export const RECOVERY_ACTIONS = [
  "retry",
  "re-read-stale-evidence",
  "inspect-state",
  "reset-scoped-state",
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

/**
 * How a surface should classify this failure when it exits.
 *
 * The field is declared here; choosing the numeric exit codes belongs to the
 * CLI owner.
 */
export const EXIT_CATEGORIES = ["user-error", "runtime-error", "cancelled", "internal"] as const;

export type ExitCategory = (typeof EXIT_CATEGORIES)[number];

/**
 * A developer-facing description of what failed underneath.
 *
 * Structural only. `detail` is bounded and redacted before it gets here, and is
 * `null` whenever there is nothing that can be said safely — an empty detail is
 * a better outcome than a leaked one.
 */
export type SafeCause = {
  /** Which boundary produced it, such as `codec` or `event-store`. */
  readonly source: string;
  /** That boundary's own code, preserved verbatim. */
  readonly code: string;
  readonly detail: string | null;
};

/**
 * Every identity that can locate a failure.
 *
 * All fields are present and nullable rather than optional, so a caller reading
 * a correlation never has to distinguish "absent" from "not applicable".
 */
export type CorrelationIds = {
  readonly workspaceId: WorkspaceId | null;
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly traceId: TraceId | null;
  readonly scopeId: ScopeId | null;
  readonly invocationId: InvocationId | null;
  readonly capabilityId: CapabilityId | null;
  readonly eventId: EventId | null;
};

export const NO_CORRELATION: CorrelationIds = {
  workspaceId: null,
  sessionId: null,
  turnId: null,
  traceId: null,
  scopeId: null,
  invocationId: null,
  capabilityId: null,
  eventId: null,
};

/** Related errors kept on one primary. Beyond this the tail is dropped and counted. */
export const MAX_RELATED_ERRORS = 32;

/** Longest user-safe message. Longer text is truncated at the boundary that builds it. */
export const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Longest developer cause detail. */
export const MAX_CAUSE_DETAIL_LENGTH = 300;

export type FalrynError = {
  /** Unstable at v0.1. Preserved verbatim when adopted from elsewhere. */
  readonly code: string;
  readonly category: ErrorCategory;
  /** Safe to show a user and safe to log. Never carries input, secrets, or source content. */
  readonly message: string;
  /**
   * Whether a later attempt may succeed and the effect contract permits one.
   *
   * Never an authorization to retry automatically — that decision belongs to the
   * retry policy, which also weighs idempotency, attempts, and elapsed budget.
   */
  readonly retryable: boolean;
  readonly effect: EffectCertainty;
  readonly cause: SafeCause | null;
  readonly correlation: CorrelationIds;
  readonly recovery: readonly RecoveryAction[];
  readonly exitCategory: ExitCategory;
  /**
   * Failures that accompanied this one, in the order they occurred.
   *
   * A cleanup failure lands here rather than being dropped because the original
   * operation had already failed.
   */
  readonly related: readonly FalrynError[];
  /** Related failures discarded past the bound, so truncation is never silent. */
  readonly relatedDropped: number;
  /**
   * Whether this build recognized the code and category.
   *
   * `false` means the error came from a newer or foreign producer and was
   * preserved as observed rather than reinterpreted.
   */
  readonly recognized: boolean;
};

/** The documented normal recovery for each effect certainty. */
const RECOVERY_BY_EFFECT: Readonly<Record<EffectCertainty, readonly RecoveryAction[]>> = {
  // The effect did not begin, so correcting input and retrying is safe.
  none: ["retry"],
  // Observed complete despite another failure. Repeating it would duplicate it.
  completed: ["inspect-state"],
  // A known subset happened; continue or repair deliberately, never blindly.
  partial: ["inspect-state", "re-read-stale-evidence"],
  // Final state cannot be established, so observe before anything else.
  uncertain: ["inspect-state"],
};

export function recoveryForEffect(effect: EffectCertainty): readonly RecoveryAction[] {
  return RECOVERY_BY_EFFECT[effect];
}

/**
 * Whether an error may be retried without first observing external state.
 *
 * Retryability alone is not enough: an effect that began and was not observed
 * has to be inspected first, or the retry duplicates it.
 */
export function isSafeToRetryWithoutInspection(error: FalrynError): boolean {
  return error.retryable && (error.effect === "none" || error.effect === "completed");
}

/** Every error in an aggregate, primary first, flattened one level. */
export function flattenErrors(error: FalrynError): readonly FalrynError[] {
  return [error, ...error.related];
}
