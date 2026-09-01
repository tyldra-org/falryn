/** Shared Falryn error construction, context, and aggregation policy. */

import {
  type CorrelationIds,
  type EffectCertainty,
  type ErrorCategory,
  type ExitCategory,
  type FalrynError,
  isErrorCategory,
  MAX_CAUSE_DETAIL_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_RELATED_ERRORS,
  NO_CORRELATION,
  type RecoveryAction,
  recoveryForEffect,
  type SafeCause,
} from "../../domain/index.ts";
import { redactText } from "../redaction.ts";

/** Longest a single operation description may be before it is truncated. */
const MAX_OPERATION_LENGTH = 120;

export type ErrorContext = {
  readonly correlation?: CorrelationIds;
  /** Short operation description. Redacted and bounded like everything else. */
  readonly operation?: string;
};

function exitCategoryFor(category: ErrorCategory): ExitCategory {
  switch (category) {
    case "cancellation":
      return "cancelled";
    case "configuration":
    case "authentication":
    case "workspace":
      return "user-error";
    case "internal":
      return "internal";
    default:
      return "runtime-error";
  }
}

/**
 * Folds an operation description into a cause.
 *
 * Re-bounded after concatenation, not only per-operation: a failure surfacing
 * through a deep call chain would otherwise accumulate one bounded fragment per
 * layer and carry unbounded text into a log.
 */
function foldOperation(
  cause: SafeCause | null,
  fallbackCode: string,
  operation: string | undefined,
): SafeCause | null {
  if (operation === undefined) {
    return cause;
  }
  const safeOperation = redactText(operation, MAX_OPERATION_LENGTH);
  const existing = cause?.detail ?? null;
  return {
    source: cause?.source ?? "application",
    code: cause?.code ?? fallbackCode,
    detail:
      existing === null
        ? safeOperation
        : redactText(`${safeOperation}: ${existing}`, MAX_CAUSE_DETAIL_LENGTH),
  };
}

export function build(input: {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly effect: EffectCertainty;
  readonly cause: SafeCause | null;
  readonly correlation?: CorrelationIds;
  readonly recovery?: readonly RecoveryAction[];
  readonly recognized?: boolean;
  /** Folded into the cause, so a translator's caller context is not discarded. */
  readonly operation?: string;
}): FalrynError {
  return {
    code: input.code,
    category: input.category,
    message: redactText(input.message, MAX_ERROR_MESSAGE_LENGTH),
    retryable: input.retryable,
    effect: input.effect,
    cause: foldOperation(input.cause, input.code, input.operation),
    correlation: input.correlation ?? NO_CORRELATION,
    recovery: input.recovery ?? recoveryForEffect(input.effect),
    exitCategory: exitCategoryFor(input.category),
    related: [],
    relatedDropped: 0,
    recognized: input.recognized ?? true,
  };
}

/** A codec rejection: the durable event boundary refused untrusted input. */

export function adoptForeignError(
  input: { readonly code: string; readonly category: string; readonly message?: string },
  context: ErrorContext = {},
): FalrynError {
  const recognized = isErrorCategory(input.category);
  return build({
    code: redactText(input.code, 120),
    category: recognized ? input.category : "internal",
    message: recognized
      ? redactText(input.message ?? `A ${input.category} failure was reported.`)
      : "A failure was reported using a category this build does not recognize.",
    retryable: false,
    effect: "uncertain",
    cause: {
      source: "foreign",
      code: redactText(input.code, 120),
      detail: recognized ? null : redactText(input.category, 120),
    },
    recognized,
    ...context,
  });
}

/**
 * Adds operation context without re-wrapping.
 *
 * Returns a new error with correlation filled in and the operation recorded on
 * the cause. The category, code, effect, and retryability are untouched — a
 * service adding context is not re-deciding what went wrong.
 */
export function withContext(error: FalrynError, context: ErrorContext): FalrynError {
  return {
    ...error,
    correlation: context.correlation ?? error.correlation,
    cause: foldOperation(error.cause, error.code, context.operation),
  };
}

/**
 * Combines an operation failure with the failures that followed it.
 *
 * The first error stays primary and the rest are attached in the order they
 * occurred. A cleanup failure is never dropped because the operation had
 * already failed — that is exactly when it is most likely to matter.
 */
export function aggregate(primary: FalrynError, related: readonly FalrynError[]): FalrynError {
  const existing = [...primary.related, ...related];
  const kept = existing.slice(0, MAX_RELATED_ERRORS);
  return {
    ...primary,
    related: kept,
    relatedDropped: primary.relatedDropped + (existing.length - kept.length),
  };
}

/**
 * Adopts shutdown participant failures into the primary-plus-related shape.
 *
 * Reads what shutdown already recorded. It does not re-run cleanup, change the
 * shutdown outcome, or reinterpret an unfinished participant as a failed one —
 * unfinished and failed are different facts and stay different.
 */
