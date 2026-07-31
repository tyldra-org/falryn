/**
 * Translation of boundary failures into the runtime failure contract.
 *
 * Each boundary is translated exactly once, here. Application services add
 * operation context with `withContext`, which never re-wraps: repeated wrapping
 * is what turns a precise failure into a nested chain nobody reads.
 *
 * The boundary unions this consumes were built to carry no user data — a codec
 * rejection reports a path and an issue code, never the value. That guarantee is
 * relied on rather than re-established: their structural fields pass through
 * unaltered.
 *
 * Redaction is applied only where *foreign* text enters — a thrown `Error`'s
 * message, an adopted foreign code, a caller-supplied operation description, a
 * shutdown participant's failure text. Running it over our own structured
 * fields would corrupt them without protecting anything.
 */

import {
  type CodecError,
  type CorrelationIds,
  type EffectCertainty,
  type ErrorCategory,
  type EventStoreError,
  type ExitCategory,
  type FalrynError,
  type IdentityError,
  isErrorCategory,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_RELATED_ERRORS,
  NO_CORRELATION,
  type ParticipantReport,
  type RecoveryAction,
  recoveryForEffect,
  type SafeCause,
  type SequenceError,
  type TimestampError,
} from "../domain/index.ts";
import { redactText } from "./redaction.ts";

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

function build(input: {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly effect: EffectCertainty;
  readonly cause: SafeCause | null;
  readonly correlation?: CorrelationIds;
  readonly recovery?: readonly RecoveryAction[];
  readonly recognized?: boolean;
}): FalrynError {
  return {
    code: input.code,
    category: input.category,
    message: redactText(input.message, MAX_ERROR_MESSAGE_LENGTH),
    retryable: input.retryable,
    effect: input.effect,
    cause: input.cause,
    correlation: input.correlation ?? NO_CORRELATION,
    recovery: input.recovery ?? recoveryForEffect(input.effect),
    exitCategory: exitCategoryFor(input.category),
    related: [],
    relatedDropped: 0,
    recognized: input.recognized ?? true,
  };
}

/** A codec rejection: the durable event boundary refused untrusted input. */
export function fromCodecError(error: CodecError, context: ErrorContext = {}): FalrynError {
  const detail =
    error.kind === "invalid-envelope"
      ? error.issues.map((issue) => `${issue.path || "<root>"}:${issue.code}`).join(", ")
      : error.kind === "unknown-event-kind"
        ? error.observedKind
        : null;

  return build({
    code: `data.codec.${error.kind}`,
    category: "data",
    message: `A runtime event could not be interpreted (${error.kind}).`,
    // Malformed input does not become well-formed on a second read.
    retryable: false,
    effect: "none",
    // Not redacted: #2 guarantees a codec rejection carries an issue path and an
    // issue code, never the rejected value. Redacting here would mangle a path
    // that happens to be named `apiKey` and destroy a useful diagnostic while
    // protecting nothing.
    cause: { source: "codec", code: error.kind, detail },
    ...context,
  });
}

export function fromIdentityError(error: IdentityError, context: ErrorContext = {}): FalrynError {
  return build({
    code: `data.identity.${error.code}`,
    category: "data",
    message: `An identifier was rejected (${error.identity}).`,
    retryable: false,
    effect: "none",
    cause: { source: "identity", code: error.code, detail: error.identity },
    ...context,
  });
}

export function fromTimestampError(error: TimestampError, context: ErrorContext = {}): FalrynError {
  return build({
    code: `data.timestamp.${error.code}`,
    category: "data",
    message: "A timestamp was not in the canonical form.",
    retryable: false,
    effect: "none",
    cause: { source: "timestamp", code: error.code, detail: null },
    ...context,
  });
}

/**
 * A sequence rejection.
 *
 * A duplicate is not modelled here: the sequencer reports a repeat as a no-op
 * receipt rather than an error, so anything reaching this function is a genuine
 * ordering conflict.
 */
export function fromSequenceError(error: SequenceError, context: ErrorContext = {}): FalrynError {
  return build({
    code: `data.sequence.${error.code}`,
    category: "data",
    message: `An event stream rejected an append (${error.code}).`,
    // A gap or an out-of-order append can succeed once the stream catches up.
    retryable: error.code === "sequence-gap" || error.code === "sequence-out-of-order",
    effect: "none",
    cause: { source: "sequence", code: error.code, detail: error.streamId },
    ...context,
  });
}

export function fromEventStoreError(
  error: EventStoreError,
  context: ErrorContext = {},
): FalrynError {
  if (error.code === "sequence") {
    return fromSequenceError(error.error, context);
  }
  if (error.code === "codec") {
    return fromCodecError(error.error, context);
  }
  if (error.code === "cancelled") {
    return build({
      code: "cancellation.event-store.cancelled",
      category: "cancellation",
      message: "The event-store operation was cancelled before it committed.",
      retryable: true,
      effect: "none",
      cause: { source: "event-store", code: "cancelled", detail: null },
      ...context,
    });
  }
  return build({
    code: "data.event-store.invalid-read-limit",
    category: "data",
    message: "An event-store read requested more than the declared limit.",
    retryable: false,
    effect: "none",
    cause: {
      source: "event-store",
      code: error.code,
      detail: `requested=${error.requestedLimit} maximum=${error.maximumLimit}`,
    },
    ...context,
  });
}

/**
 * Normalizes an unknown throw.
 *
 * `catch` receives `unknown`, and the value is frequently a foreign `Error`
 * whose message was written by a library with no idea what is sensitive. Only
 * the message is taken, and it is redacted; the stack is discarded, because a
 * stack carries absolute paths and sometimes arguments.
 */
export function fromUnknown(thrown: unknown, context: ErrorContext = {}): FalrynError {
  const detail =
    thrown instanceof Error
      ? redactText(thrown.message)
      : typeof thrown === "string"
        ? redactText(thrown)
        : null;

  return build({
    code: "internal.unexpected",
    category: "internal",
    message: "An unexpected internal failure occurred.",
    retryable: false,
    // Nothing observed the effect of code that threw where it should not have.
    effect: "uncertain",
    cause: { source: "unknown", code: "thrown", detail },
    ...context,
  });
}

/**
 * Adopts an error described by a foreign or newer producer.
 *
 * An unrecognized category is preserved in the cause and the error is marked
 * unrecognized, rather than being mapped onto a known category that means
 * something else. Reading `data` where the producer said `provider` would be a
 * worse outcome than admitting the code is not understood.
 */
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
  const operation = context.operation === undefined ? null : redactText(context.operation, 120);
  const cause: SafeCause | null =
    operation === null
      ? error.cause
      : {
          source: error.cause?.source ?? "application",
          code: error.cause?.code ?? error.code,
          detail:
            error.cause?.detail === null || error.cause?.detail === undefined
              ? operation
              : `${operation}: ${error.cause.detail}`,
        };

  return {
    ...error,
    correlation: context.correlation ?? error.correlation,
    cause,
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
export function fromParticipantReports(
  reports: readonly ParticipantReport[],
  context: ErrorContext = {},
): readonly FalrynError[] {
  return reports
    .filter((report) => report.status !== "completed")
    .map((report) =>
      build({
        code:
          report.status === "failed"
            ? "internal.shutdown.participant-failed"
            : "cancellation.shutdown.participant-unfinished",
        category: report.status === "failed" ? "internal" : "cancellation",
        message:
          report.status === "failed"
            ? "A shutdown participant failed."
            : "A shutdown participant did not finish before its phase ended.",
        retryable: false,
        // Unfinished work was not observed stopping; a failure reported itself.
        effect: report.status === "failed" ? "partial" : "uncertain",
        cause: {
          source: "shutdown",
          code: report.status,
          detail:
            report.failure === null ? report.name : redactText(`${report.name}: ${report.failure}`),
        },
        ...context,
      }),
    );
}
