/**
 * Optional compact-model compression lane (#106).
 *
 * Learned extraction or synthesis through the `compact` role. The model is
 * optional: `off`, unavailable, malformed, or no-savings outcomes fall back to
 * passthrough without a second model call. Model projections never claim
 * exact-source. Product tools and fidelity eval remain later.
 */

import { z } from "zod";

import { type ContentDigest, isArtifactSensitivity } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import {
  type EvidenceFidelity,
  type ExactSourceHandle,
  MAX_EVIDENCE_INLINE_BYTES,
} from "./context-evidence.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const COMPACT_MODEL_VERSION = "compact.v1";
export const DEFAULT_COMPACT_MAX_BYTES = 8 * 1_024;
export const HARD_COMPACT_MAX_BYTES = MAX_EVIDENCE_INLINE_BYTES;
export const MAX_COMPACT_QUESTION_BYTES = 1_024;

export const COMPACT_USES = ["evaluated", "off"] as const;
export type CompactUse = (typeof COMPACT_USES)[number];

export const COMPACT_STRATEGIES = ["compact-model", "passthrough"] as const;
export type CompactStrategy = (typeof COMPACT_STRATEGIES)[number];

export const COMPACT_MODEL_KINDS = ["extractive", "lossy"] as const;
export type CompactModelKind = (typeof COMPACT_MODEL_KINDS)[number];

export const COMPACT_FALLBACK_REASONS = [
  "disabled",
  "unavailable",
  "malformed",
  "oversized",
  "timed-out",
  "rate-limited",
  "disconnected",
  "refused",
  "no-savings",
  "empty-projection",
] as const;
export type CompactFallbackReason = (typeof COMPACT_FALLBACK_REASONS)[number];

export type CompactErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "unavailable"
  | "secret"
  | "empty"
  | "cancelled"
  | "overflow-exhausted";

export type CompactError = {
  readonly kind: "compact";
  readonly code: CompactErrorCode;
  readonly field: string | null;
};

export type CompactModelFailureCode =
  | "unavailable"
  | "cancelled"
  | "timed-out"
  | "malformed"
  | "oversized"
  | "rate-limited"
  | "disconnected"
  | "refused";

export type CompactModelFailure = {
  readonly code: CompactModelFailureCode;
};

export type CompactModelRequest = {
  readonly text: string;
  readonly question: string | null;
  readonly maxBytes: number;
};

export type CompactModelSuccess = {
  readonly text: string;
  readonly kind: CompactModelKind;
};

export type CompactModelPort = {
  compact(request: CompactModelRequest): Result<CompactModelSuccess, CompactModelFailure>;
};

export type CompactReduceInput = {
  readonly text?: unknown;
  readonly question?: unknown;
  readonly sensitivity?: unknown;
  readonly maxBytes?: unknown;
  readonly compactUse?: unknown;
  readonly cancelled?: unknown;
};

export type CompactReduceResult = {
  readonly strategyVersion: typeof COMPACT_MODEL_VERSION;
  readonly compactUse: CompactUse;
  readonly selectedStrategy: CompactStrategy;
  readonly fallbackDestination: "passthrough" | null;
  readonly fallbackReason: CompactFallbackReason | null;
  readonly modelKind: CompactModelKind | null;
  readonly evidenceFidelity: EvidenceFidelity;
  readonly claimsExact: boolean;
  readonly complete: boolean;
  readonly text: string;
  readonly sourceBytes: number;
  readonly reducedBytes: number;
  readonly expansion: ExactSourceHandle | null;
  readonly modelCalls: number;
};

const encoder = new TextEncoder();

const compactUseSchema = z.enum(COMPACT_USES);

function compactError(code: CompactErrorCode, field: string | null): CompactError {
  return { kind: "compact", code, field };
}

export function describeCompactError(error: CompactError): string {
  const field = error.field === null ? "compact" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "unavailable":
      return `unavailable ${field}`;
    case "secret":
      return `secret ${field}`;
    case "empty":
      return `empty ${field}`;
    case "cancelled":
      return `cancelled ${field}`;
    case "overflow-exhausted":
      return `overflow-exhausted ${field}`;
    default:
      return assertNever(error.code, "unhandled compact error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function hashBytes(hasher: ContentHasherPort, bytes: Uint8Array): ContentDigest {
  const hash = hasher.create();
  hash.update(bytes);
  return hash.digest();
}

function parseBound(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): Result<number, CompactError> {
  if (value === undefined) {
    return ok(fallback);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return err(compactError("malformed", field));
  }
  if (value > maximum) {
    return err(compactError("oversized", field));
  }
  return ok(value);
}

function parseText(value: unknown, field: string): Result<string, CompactError> {
  if (typeof value !== "string") {
    return err(compactError("malformed", field));
  }
  if (value.length === 0) {
    return err(compactError("empty", field));
  }
  if (value.includes("\0")) {
    return err(compactError("malformed", field));
  }
  return ok(value);
}

function passthroughResult(
  original: string,
  maxBytes: number,
  compactUse: CompactUse,
  reason: CompactFallbackReason | null,
  hasher: ContentHasherPort,
): CompactReduceResult {
  const bytes = encoder.encode(original);
  const complete = bytes.byteLength <= maxBytes;
  const text = complete ? original : original.slice(0, maxBytes);
  const reducedBytes = byteLength(text);
  return {
    strategyVersion: COMPACT_MODEL_VERSION,
    compactUse,
    selectedStrategy: "passthrough",
    fallbackDestination: reason === null ? null : "passthrough",
    fallbackReason: reason,
    modelKind: null,
    evidenceFidelity: complete ? "exact-source" : "deterministic-transform",
    claimsExact: complete,
    complete,
    text,
    sourceBytes: bytes.byteLength,
    reducedBytes,
    expansion: {
      kind: "inline",
      digest: hashBytes(hasher, bytes),
      byteLength: bytes.byteLength,
    },
    modelCalls: 0,
  };
}

function fidelityForKind(kind: CompactModelKind): EvidenceFidelity {
  switch (kind) {
    case "extractive":
      return "extractive-summary";
    case "lossy":
      return "lossy-synthesis";
    default:
      return assertNever(kind, "unhandled compact model kind");
  }
}

function fallbackReasonForFailure(code: CompactModelFailureCode): CompactFallbackReason | null {
  switch (code) {
    case "unavailable":
      return "unavailable";
    case "cancelled":
      return null;
    case "timed-out":
      return "timed-out";
    case "malformed":
      return "malformed";
    case "oversized":
      return "oversized";
    case "rate-limited":
      return "rate-limited";
    case "disconnected":
      return "disconnected";
    case "refused":
      return "refused";
    default:
      return assertNever(code, "unhandled compact model failure");
  }
}

/**
 * Project text through the optional compact-model lane.
 *
 * `port` is invoked at most once. Fallback never calls it. Cancellation and
 * restricted/secret input fail closed instead of substituting a projection.
 */
export function reduceCompact(
  input: CompactReduceInput,
  hasher: ContentHasherPort,
  port: CompactModelPort | null,
): Result<CompactReduceResult, CompactError> {
  if (input.cancelled === true) {
    return err(compactError("cancelled", "signal"));
  }
  const text = parseText(input.text, "text");
  if (!text.ok) {
    return text;
  }
  const maxBytes = parseBound(
    input.maxBytes,
    "maxBytes",
    DEFAULT_COMPACT_MAX_BYTES,
    1,
    HARD_COMPACT_MAX_BYTES,
  );
  if (!maxBytes.ok) {
    return maxBytes;
  }
  if (byteLength(text.value) > HARD_COMPACT_MAX_BYTES) {
    return err(compactError("oversized", "text"));
  }
  const useParsed = compactUseSchema.safeParse(input.compactUse ?? "evaluated");
  if (!useParsed.success) {
    return err(compactError("malformed", "compactUse"));
  }
  const compactUse = useParsed.data;
  const sensitivity = input.sensitivity === undefined ? "user-content" : input.sensitivity;
  if (!isArtifactSensitivity(sensitivity)) {
    return err(compactError("malformed", "sensitivity"));
  }
  if (sensitivity === "restricted") {
    return err(compactError("secret", "sensitivity"));
  }
  let question: string | null = null;
  if (input.question !== undefined) {
    if (typeof input.question !== "string") {
      return err(compactError("malformed", "question"));
    }
    if (input.question.includes("\0")) {
      return err(compactError("malformed", "question"));
    }
    if (byteLength(input.question) > MAX_COMPACT_QUESTION_BYTES) {
      return err(compactError("oversized", "question"));
    }
    question = input.question;
  }

  if (compactUse === "off") {
    return ok(passthroughResult(text.value, maxBytes.value, compactUse, "disabled", hasher));
  }

  if (port === null) {
    return ok(passthroughResult(text.value, maxBytes.value, compactUse, "unavailable", hasher));
  }

  const compacted = port.compact({
    text: text.value,
    question,
    maxBytes: maxBytes.value,
  });
  if (!compacted.ok) {
    if (compacted.error.code === "cancelled") {
      return err(compactError("cancelled", "model"));
    }
    const reason = fallbackReasonForFailure(compacted.error.code);
    if (reason === null) {
      return err(compactError("cancelled", "model"));
    }
    return ok(passthroughResult(text.value, maxBytes.value, compactUse, reason, hasher));
  }

  const projection = compacted.value.text;
  if (projection.length === 0 || projection.includes("\0")) {
    return ok(
      passthroughResult(text.value, maxBytes.value, compactUse, "empty-projection", hasher),
    );
  }
  const reducedBytes = byteLength(projection);
  if (reducedBytes > maxBytes.value) {
    return ok(passthroughResult(text.value, maxBytes.value, compactUse, "oversized", hasher));
  }
  const sourceBytes = byteLength(text.value);
  if (reducedBytes >= sourceBytes) {
    return ok(passthroughResult(text.value, maxBytes.value, compactUse, "no-savings", hasher));
  }

  const bytes = encoder.encode(text.value);
  return ok({
    strategyVersion: COMPACT_MODEL_VERSION,
    compactUse,
    selectedStrategy: "compact-model",
    fallbackDestination: null,
    fallbackReason: null,
    modelKind: compacted.value.kind,
    evidenceFidelity: fidelityForKind(compacted.value.kind),
    claimsExact: false,
    complete: false,
    text: projection,
    sourceBytes,
    reducedBytes,
    expansion: {
      kind: "inline",
      digest: hashBytes(hasher, bytes),
      byteLength: bytes.byteLength,
    },
    modelCalls: 1,
  });
}
