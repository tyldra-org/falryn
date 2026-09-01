/** Codec, identity, time, sequence, and event-store translations. */

import type {
  CodecError,
  EventStoreError,
  FalrynError,
  IdentityError,
  SequenceError,
  TimestampError,
} from "../../domain/index.ts";
import { build, type ErrorContext } from "./shared.ts";
import { fromSqliteStoreError } from "./storage.ts";

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
  if (error.code === "storage") {
    // Translated by the store's own owner rather than re-summarized here: a
    // busy database, a full disk, and a closed connection each carry an
    // operation and an effect certainty that this layer would have to discard.
    return fromSqliteStoreError(error.error, context);
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
