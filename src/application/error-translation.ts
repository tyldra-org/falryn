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
  blockingIssues,
  type CodecError,
  type ConfigurationIssue,
  type CorrelationIds,
  type CredentialFailure,
  type CredentialUnresolvedStatus,
  type EffectCertainty,
  type ErrorCategory,
  type EventStoreError,
  type ExitCategory,
  type FalrynError,
  type IdentityError,
  isErrorCategory,
  MAX_CAUSE_DETAIL_LENGTH,
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
 * A configuration rejection.
 *
 * Every field folded into the cause is structural — a key path, a declared
 * bound, an allowed option list, a schema version. The registry guarantees the
 * issue never carries the rejected value, so a file whose invalid value is a
 * token produces an error that is safe to log, export, and attach to a support
 * bundle. Nothing here is redacted for the same reason a codec rejection is
 * not: redacting a key path legitimately named `apiKey` would destroy the only
 * useful part of the diagnostic while protecting nothing.
 */
export function fromConfigurationIssue(
  issue: ConfigurationIssue,
  context: ErrorContext = {},
): FalrynError {
  return build({
    code: `configuration.${issue.kind}`,
    category: "configuration",
    message: configurationMessage(issue),
    // A file does not become valid on a second read; someone has to change it.
    retryable: false,
    effect: "none",
    recovery: ["inspect-state"],
    cause: { source: "configuration", code: issue.kind, detail: configurationDetail(issue) },
    ...context,
  });
}

/**
 * Every blocking issue as one error.
 *
 * Warnings are dropped rather than promoted: a resolved alias and a deprecated
 * key are accepted facts, and turning them into failures would make a working
 * configuration look broken. Returns `null` when nothing blocked.
 */
export function fromConfigurationIssues(
  issues: readonly ConfigurationIssue[],
  context: ErrorContext = {},
): FalrynError | null {
  const blocking = blockingIssues(issues);
  const [primary, ...rest] = blocking;
  if (primary === undefined) {
    return null;
  }
  return aggregate(
    fromConfigurationIssue(primary, context),
    rest.map((issue) => fromConfigurationIssue(issue, context)),
  );
}

function configurationMessage(issue: ConfigurationIssue): string {
  switch (issue.kind) {
    case "unknown-key":
      return "A configuration key is not recognized.";
    case "invalid-type":
      return `A configuration value is not a ${issue.expected}.`;
    case "out-of-range":
      return "A configuration value is outside its allowed range.";
    case "invalid-value":
      return "A configuration value is not one of the allowed values.";
    case "plaintext-credential":
      return "A configuration key expects a credential reference, not a secret value.";
    case "scope-unavailable":
      return `A configuration key cannot be set from ${issue.scope} configuration.`;
    case "duplicate-identity":
      return "A configuration list repeats an identity.";
    case "cross-field-conflict":
      return "Two configuration values cannot both be in effect.";
    case "invalid-schema-version":
      return "A configuration document does not declare a usable schema version.";
    case "unsupported-schema-version":
      return "A configuration document requires a newer build.";
    case "retired-schema-version":
      return "A configuration document predates the oldest version this build reads.";
    case "alias-resolved":
      return "A configuration key was written using a deprecated name.";
    case "deprecated-key":
      return "A configuration key is deprecated.";
    case "ignored-forward-key":
      return "A configuration key from a newer schema version was ignored.";
  }
}

function configurationDetail(issue: ConfigurationIssue): string {
  const facts: string[] = [`path=${issue.path || "<root>"}`];
  switch (issue.kind) {
    case "invalid-type":
      facts.push(`expected=${issue.expected}`);
      break;
    case "out-of-range":
      facts.push(`minimum=${issue.minimum ?? "none"}`, `maximum=${issue.maximum ?? "none"}`);
      if (issue.unit !== null) {
        facts.push(`unit=${issue.unit}`);
      }
      break;
    case "invalid-value":
      facts.push(`allowed=${issue.allowed.join("|")}`);
      break;
    case "plaintext-credential":
      facts.push(`expectedStoreKinds=${issue.expectedStoreKinds.join("|")}`);
      break;
    case "scope-unavailable":
      facts.push(`scope=${issue.scope}`, `available=${issue.availableScopes.join("|")}`);
      break;
    case "duplicate-identity":
      facts.push(`identityField=${issue.identityField}`);
      break;
    case "cross-field-conflict":
      facts.push(`rule=${issue.rule}`, `related=${issue.relatedPaths.join("|")}`);
      break;
    case "unsupported-schema-version":
      facts.push(
        `observed=${issue.observedSchemaVersion}`,
        `minimumCompatible=${issue.minimumCompatibleVersion}`,
        `reader=${issue.readerSchemaVersion}`,
      );
      break;
    case "retired-schema-version":
      facts.push(
        `observed=${issue.observedSchemaVersion}`,
        `minimumSupported=${issue.minimumSupportedVersion}`,
      );
      break;
    case "alias-resolved":
      facts.push(`canonical=${issue.canonical}`);
      break;
    case "deprecated-key":
      facts.push(
        `replacement=${issue.replacement ?? "none"}`,
        `removedIn=${issue.removedInSchemaVersion ?? "none"}`,
      );
      break;
    case "ignored-forward-key":
      facts.push(`observed=${issue.observedSchemaVersion}`, `reader=${issue.readerSchemaVersion}`);
      break;
    case "unknown-key":
    case "invalid-schema-version":
      break;
  }
  return facts.join(" ");
}

/**
 * A credential that could not be resolved.
 *
 * This is the first producer of the `authentication` category. Nothing here is
 * redacted, for the same reason a configuration issue is not: a credential
 * failure is built from a status, a Falryn code, a store kind, and a consumer
 * name, all of which come from declarations rather than from the store. The
 * locator is deliberately absent — it is withheld from every rendering, and an
 * error is a rendering.
 *
 * `effect` is always `none`. Reading a credential changes nothing, so a caller
 * never has to inspect state before trying again; what stops an automatic retry
 * is `retryable`, which the store sets from whether the state that caused the
 * failure can change at all.
 */
export function fromCredentialFailure(
  failure: CredentialFailure,
  context: ErrorContext = {},
): FalrynError {
  return build({
    code: `authentication.${failure.status}`,
    category: "authentication",
    message: credentialMessage(failure.status),
    retryable: failure.retryable,
    effect: "none",
    recovery: ["inspect-state"],
    cause: {
      source: "credentials",
      code: failure.code,
      detail: `store=${failure.storeKind} consumer=${failure.consumer} health=${failure.health.state}`,
    },
    ...context,
  });
}

function credentialMessage(status: CredentialUnresolvedStatus): string {
  switch (status) {
    case "missing":
      return "No credential is stored for this reference.";
    case "empty":
      return "The stored credential is empty.";
    case "locked":
      return "The credential store is locked and cannot be opened without interaction.";
    case "denied":
      return "The credential store refused this request.";
    case "unavailable":
      return "The credential store could not be reached.";
    case "unsupported":
      return "This build does not support this credential store on this platform.";
    case "timed-out":
      return "The credential store did not answer before the deadline.";
    case "cancelled":
      return "The credential lookup was cancelled before it completed.";
    case "malformed":
      return "The credential reference does not name something this store can look for.";
  }
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
