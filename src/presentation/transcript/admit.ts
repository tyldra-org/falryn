/**
 * Admission for untrusted transcript records.
 *
 * Semantic blocks are produced by `reduceTranscript` from runtime events. This
 * gate exists for the other case: a record whose kind this build does not
 * declare. Mapping that kind onto `notice` or `diagnostic` would make an
 * unrecognized object look like something Falryn understood. Refusing it would
 * drop it from the transcript. The fallback is a typed `unknown` block that
 * names the gap without copying the payload.
 *
 * Known kinds are refused here rather than constructed. Their producer is the
 * reducer; this module is not a second one.
 */

import {
  assertNever,
  err,
  MAX_IDENTIFIER_LENGTH,
  ok,
  parseTimestamp,
  type Result,
} from "../../domain/index.ts";
import {
  BLOCK_SENSITIVITIES,
  BLOCK_SOURCES,
  BLOCK_STATUSES,
  isTranscriptBlockKind,
  UNKNOWN_TRANSCRIPT_BLOCK_KIND,
  type UnknownBlock,
} from "./blocks.ts";
import { bound, complete } from "./disclosure.ts";
import { TRANSCRIPT_PROJECTION_GENERATION } from "./generation.ts";

export const TRANSCRIPT_BLOCK_ADMISSION_ERROR_CODES = [
  "malformed",
  "unsupported",
  "oversized",
] as const;

export type TranscriptBlockAdmissionErrorCode =
  (typeof TRANSCRIPT_BLOCK_ADMISSION_ERROR_CODES)[number];

export type TranscriptBlockAdmissionError = {
  readonly kind: "transcript-block-admission";
  readonly code: TranscriptBlockAdmissionErrorCode;
  readonly field: string | null;
};

/**
 * An untrusted record. Extra fields are dropped; they are never copied onto
 * the admitted block.
 */
export type TranscriptRecordInput = {
  readonly kind?: unknown;
  readonly order?: unknown;
  readonly occurredAt?: unknown;
  readonly source?: unknown;
  readonly status?: unknown;
  readonly sensitivity?: unknown;
  readonly [field: string]: unknown;
};

/**
 * Hard cap on the observed kind string before bounding.
 *
 * Bounding still applies inside this cap. Above it the record is refused so a
 * multi-megabyte kind cannot become retained text, and the error carries no
 * copy of the string.
 */
export const MAX_OBSERVED_KIND_CHARS = MAX_IDENTIFIER_LENGTH * 16;

export function describeTranscriptBlockAdmissionError(
  error: TranscriptBlockAdmissionError,
): string {
  const field = error.field === null ? "record" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    default:
      return assertNever(error.code, "unhandled transcript block admission error");
  }
}

export function admitTranscriptRecord(
  input: TranscriptRecordInput,
): Result<UnknownBlock, TranscriptBlockAdmissionError> {
  if (typeof input.kind !== "string" || input.kind.length === 0) {
    return err(admissionError("malformed", "kind"));
  }
  if (input.kind.length > MAX_OBSERVED_KIND_CHARS) {
    return err(admissionError("oversized", "kind"));
  }
  if (isTranscriptBlockKind(input.kind)) {
    return err(admissionError("unsupported", "kind"));
  }

  if (typeof input.order !== "number" || !Number.isSafeInteger(input.order) || input.order < 0) {
    return err(admissionError("malformed", "order"));
  }

  const occurredAt = parseTimestamp(input.occurredAt);
  if (!occurredAt.ok) {
    return err(admissionError("malformed", "occurredAt"));
  }

  const block: UnknownBlock = {
    kind: UNKNOWN_TRANSCRIPT_BLOCK_KIND,
    anchor: { of: "declared", key: `unknown:${input.order}` },
    occurredAt: occurredAt.value,
    order: input.order,
    source: pickEnum(input.source, BLOCK_SOURCES, "runtime"),
    status: pickEnum(input.status, BLOCK_STATUSES, "final"),
    summary: complete("Unrecognized block"),
    sensitivity: pickEnum(input.sensitivity, BLOCK_SENSITIVITIES, "ordinary"),
    invocationId: null,
    artifactIds: [],
    renderGeneration: TRANSCRIPT_PROJECTION_GENERATION,
    observedKind: bound(input.kind, { bytes: MAX_IDENTIFIER_LENGTH, lines: 1 }),
  };
  return ok(block);
}

function admissionError(
  code: TranscriptBlockAdmissionErrorCode,
  field: string | null,
): TranscriptBlockAdmissionError {
  return { kind: "transcript-block-admission", code, field };
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}
