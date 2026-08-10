/**
 * Artifacts: large or binary content stored as bytes outside SQLite, described
 * by a durable record, and reachable only through one port.
 *
 * An artifact is two things that have to stay consistent with each other — a
 * row that describes it and a blob that is it — so the contracts below keep the
 * two apart on purpose and name exactly how they meet.
 *
 * Five rules the types carry rather than document:
 *
 * - **A record is metadata; it never carries content.** The record holds a
 *   digest, a media type, a byte length, and a sensitivity label. Reading bytes
 *   is a separate, bounded operation, so a caller that wants to describe a
 *   500 MB capture never accidentally loads one.
 * - **Bytes are addressed, never pathed.** {@link BlobLocation} names a scope
 *   and a content digest. No filesystem path crosses the port, which is what
 *   keeps every path inside the one adapter that writes bytes and out of every
 *   error, event, and diagnostic.
 * - **A rejection reports structure only.** No path, digest, or byte appears in
 *   an {@link ArtifactError}. Byte lengths and offsets do, because a range that
 *   was refused is undiagnosable without them and a length is not content.
 * - **Availability is one column, not a guess.** `reserved` means bytes are in
 *   flight, `available` means they were verified and finalized, `quarantined`
 *   means they were finalized and did *not* verify, and `missing` means a row
 *   describes bytes that are not there. Nothing infers these from a stat.
 * - **A digest names the function that produced it.** `sha-256:<hex>` rather
 *   than bare hex, so a second algorithm is a new prefix rather than a string
 *   nobody can re-verify.
 */

import { z } from "zod";
import type { BlobError } from "./blob.ts";
import { brandedString, timestampSchema } from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import {
  type ArtifactId,
  type ContentDigest,
  type IdentifierCodec,
  type IdentityError,
  type IdentityErrorCode,
  type InvocationId,
  invocationId,
} from "./identity.ts";
import type { MeasurementCompleteness } from "./local-data.ts";
import type { EffectCertainty } from "./outcome.ts";
import { err, ok, type Result } from "./result.ts";
import type { SqliteStoreError } from "./sqlite.ts";
import type { Timestamp } from "./time.ts";

export type { ArtifactId, ContentDigest } from "./identity.ts";

/** The one digest function this build computes and verifies. */
export const CONTENT_DIGEST_ALGORITHM = "sha-256";

/** `sha-256:` followed by 64 lowercase hexadecimal characters. */
const CONTENT_DIGEST = /^sha-256:[0-9a-f]{64}$/;

/** Longest artifact identity accepted. Identities are labels, not content. */
export const MAX_ARTIFACT_ID_LENGTH = 128;

/**
 * Alphanumeric first, then alphanumerics, dot, underscore, and hyphen.
 *
 * Narrower than every other Falryn identity, and deliberately: an artifact
 * identity names an in-flight file. Allowing the printable ASCII the rest of
 * them allow would let a separator, a leading dot, or `..` reach a path
 * component, and refusing that at the parser is worth more than the characters
 * it costs.
 */
const LEGAL_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** How an in-flight artifact's bytes are named while they are being written. */
export const TEMPORARY_ARTIFACT_PREFIX = "artifact-";
export const TEMPORARY_ARTIFACT_SUFFIX = ".part";

/** The file name in-flight bytes for `id` are written under. */
export function temporaryArtifactName(id: ArtifactId): string {
  return `${TEMPORARY_ARTIFACT_PREFIX}${id}${TEMPORARY_ARTIFACT_SUFFIX}`;
}

/**
 * Whether a temporary-ingest entry is in-flight artifact bytes.
 *
 * The marker startup reconciliation needs to say more than "something is here".
 * It still concludes nothing about whether the write finished — that stays
 * knowable only from the record beside it — but it can now name the owner.
 */
export function isTemporaryArtifactName(name: string): boolean {
  return (
    name.startsWith(TEMPORARY_ARTIFACT_PREFIX) &&
    name.endsWith(TEMPORARY_ARTIFACT_SUFFIX) &&
    artifactId.parse(
      name.slice(TEMPORARY_ARTIFACT_PREFIX.length, name.length - TEMPORARY_ARTIFACT_SUFFIX.length),
    ).ok
  );
}

function identityError(code: IdentityErrorCode, identity: string): IdentityError {
  return { kind: "identity", code, identity };
}

function createCodec<Value extends string>(
  identity: string,
  pattern: RegExp,
  maximumLength: number,
): IdentifierCodec<Value> {
  const parse = (value: unknown): Result<Value, IdentityError> => {
    if (typeof value !== "string") {
      return err(identityError("identifier-not-a-string", identity));
    }
    if (value.length === 0) {
      return err(identityError("identifier-empty", identity));
    }
    if (value.length > maximumLength) {
      return err(identityError("identifier-too-long", identity));
    }
    if (!pattern.test(value)) {
      return err(identityError("identifier-illegal-character", identity));
    }
    return ok(value as Value);
  };

  return {
    identity,
    parse,
    from(value: string): Value {
      const parsed = parse(value);
      if (!parsed.ok) {
        throw new Error(`invalid ${identity}: ${parsed.error.code}`);
      }
      return parsed.value;
    },
  };
}

export const artifactId = createCodec<ArtifactId>(
  "artifactId",
  LEGAL_ARTIFACT_ID,
  MAX_ARTIFACT_ID_LENGTH,
);

export const contentDigest = createCodec<ContentDigest>(
  "contentDigest",
  CONTENT_DIGEST,
  `${CONTENT_DIGEST_ALGORITHM}:`.length + 64,
);

/**
 * How much of an artifact may leave the machine, and to whom.
 *
 * Decided by this delivery, because no canonical vocabulary existed. Labels are
 * carried on the record and never inferred from content: guessing that a diff
 * is safe because it parses as text is exactly the inference that leaks a key
 * somebody pasted into a file.
 *
 * The four are ordered by exposure, and each earns its place by changing a
 * decision some later owner has to make:
 *
 * - `public` — Falryn's own output about itself. Safe in a support bundle.
 * - `user-content` — the user's working material. Exportable on request; never
 *   attached to a diagnostic the user did not ask for.
 * - `sensitive` — content believed to carry personal or confidential material.
 *   Withheld from model projection and support bundles unless selected.
 * - `restricted` — content that must not leave this machine at all. Not
 *   exportable, not projectable, not attachable.
 */
export const ARTIFACT_SENSITIVITIES = [
  "public",
  "user-content",
  "sensitive",
  "restricted",
] as const;

export type ArtifactSensitivity = (typeof ARTIFACT_SENSITIVITIES)[number];

/**
 * Where an artifact came from.
 *
 * Provenance the producer states rather than one derived from a media type. The
 * complete provenance *graph* — parent transformations and lineage — is a later
 * owner's; this is the single fact a record needs to be describable.
 */
export const ARTIFACT_ORIGINS = [
  "tool-output",
  "model-output",
  "user-supplied",
  "capture",
  "diagnostic",
] as const;

export type ArtifactOrigin = (typeof ARTIFACT_ORIGINS)[number];

/**
 * The content coding the stored bytes are in.
 *
 * Carried and returned; never applied. This store hashes, stores, and hands
 * back exactly the bytes it was given, and the decoding limits that would make
 * expanding `gzip` safe belong to the viewer owner. A caller that stores gzip
 * bytes gets gzip bytes back and a label saying so.
 */
export const ARTIFACT_ENCODINGS = ["identity", "gzip"] as const;

export type ArtifactEncoding = (typeof ARTIFACT_ENCODINGS)[number];

/**
 * Whether an artifact's bytes can be read, and why not when they cannot.
 *
 * `reserved` is the only state with no finalized time, which is what the
 * schema constrains: a row can never be half-finalized.
 */
export const ARTIFACT_AVAILABILITIES = [
  /** Metadata committed; bytes are in flight or were never finalized. */
  "reserved",
  /** Bytes finalized and their digest verified. */
  "available",
  /** Bytes finalized and their digest did not match. Kept for inspection. */
  "quarantined",
  /** A record describes bytes that are not present. Never inferred here. */
  "missing",
] as const;

export type ArtifactAvailability = (typeof ARTIFACT_AVAILABILITIES)[number];

/** Longest media type stored. A media type is a label, not a header. */
export const MAX_MEDIA_TYPE_LENGTH = 128;

/** `type/subtype` with the parameters a stored label is allowed to keep. */
const MEDIA_TYPE = /^[!-~]+\/[!-~]+$/;

/**
 * The hard per-artifact ceiling, above which no configured limit may reach.
 *
 * A bound rather than a policy: configuration chooses a ceiling inside this
 * one, and a request above either is an error rather than a silent truncation.
 */
export const MAX_ARTIFACT_BYTES = 4 * 1_024 * 1_024 * 1_024;

/** The declared default for the configured per-artifact ceiling. */
export const DEFAULT_ARTIFACT_MAX_BYTES = 64 * 1_024 * 1_024;

/** Most bytes one range read may return. */
export const MAX_ARTIFACT_RANGE_BYTES = 8 * 1_024 * 1_024;

/** Most bytes a preview may return. A preview is a glance, not a read. */
export const MAX_ARTIFACT_PREVIEW_BYTES = 64 * 1_024;

/** Most records one artifact listing may return. */
export const MAX_ARTIFACT_LIST_LIMIT = 1_000;

/**
 * One artifact's durable description.
 *
 * `invocationId` is nullable because bytes can be ingested before any
 * invocation claims them, and with `foreign_keys = ON` a non-null key to a row
 * that may not exist is a write nobody can perform.
 */
export type ArtifactRecord = {
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly mediaType: string;
  readonly encoding: ArtifactEncoding;
  readonly byteLength: number;
  readonly sensitivity: ArtifactSensitivity;
  readonly origin: ArtifactOrigin;
  /** The invocation that produced it, or `null` when none claims it. */
  readonly invocationId: InvocationId | null;
  readonly createdAt: Timestamp;
  /** When the bytes reached their final location, or `null` while reserved. */
  readonly finalizedAt: Timestamp | null;
  readonly availability: ArtifactAvailability;
};

/**
 * Which store failed, and how.
 *
 * Metadata and bytes fail for unrelated reasons — a busy database is not a full
 * disk — and folding them into one code would send somebody looking at the
 * wrong subsystem.
 */
export type ArtifactStorageFailure =
  | { readonly medium: "metadata"; readonly error: SqliteStoreError }
  | { readonly medium: "bytes"; readonly error: BlobError };

/**
 * Every way an artifact operation fails.
 *
 * No member carries a path, a digest, or a byte. A byte length and an offset
 * are carried, because a refused range is undiagnosable without them and
 * neither is content.
 */
export type ArtifactError =
  /** A stored row is not a record this build can interpret. */
  | {
      readonly kind: "artifact";
      readonly code: "malformed-row";
      readonly issues: readonly CodecIssue[];
    }
  | {
      readonly kind: "artifact";
      readonly code: "storage";
      readonly failure: ArtifactStorageFailure;
      readonly artifactId: ArtifactId | null;
    }
  | { readonly kind: "artifact"; readonly code: "already-exists"; readonly artifactId: ArtifactId }
  | { readonly kind: "artifact"; readonly code: "not-found"; readonly artifactId: ArtifactId }
  /** The bytes hashed to something other than what was recorded. Quarantined. */
  | { readonly kind: "artifact"; readonly code: "digest-mismatch"; readonly artifactId: ArtifactId }
  | {
      readonly kind: "artifact";
      readonly code: "size-mismatch";
      readonly artifactId: ArtifactId;
      readonly declaredByteLength: number;
      readonly observedByteLength: number;
    }
  | {
      readonly kind: "artifact";
      readonly code: "oversize";
      readonly artifactId: ArtifactId;
      readonly requestedByteLength: number;
      readonly maximumByteLength: number;
    }
  | {
      readonly kind: "artifact";
      readonly code: "range-out-of-bounds";
      readonly artifactId: ArtifactId;
      readonly requestedOffset: number;
      readonly requestedLength: number;
      readonly byteLength: number;
    }
  /** The record exists and its bytes cannot be read in their current state. */
  | {
      readonly kind: "artifact";
      readonly code: "unavailable-bytes";
      readonly artifactId: ArtifactId;
      readonly availability: ArtifactAvailability;
    }
  | {
      readonly kind: "artifact";
      readonly code: "invalid-list-limit";
      readonly requestedLimit: number;
      readonly maximumLimit: number;
    }
  /** Cancelled before anything committed. Never reported after a commit. */
  | {
      readonly kind: "artifact";
      readonly code: "cancelled";
      readonly artifactId: ArtifactId | null;
    };

/** What one metadata write did. Mirrors the store's cancellation contract. */
export type ArtifactWrite = {
  readonly cancelledAfterCommit: boolean;
};

/** Digests one reference check may ask about at once. */
export const MAX_DIGEST_BATCH = 500;

/**
 * The metadata half of an artifact, as three transitions and three reads.
 *
 * The write surface is deliberately not insert-and-update: an artifact's row is
 * created `reserved` and then moves once, to `available` or to `quarantined`.
 * Both transitions are decided inside the transaction that performs them, so a
 * finalize naming an absent row reports `not-found` and one naming a row that
 * already moved reports `already-exists`, rather than a silent zero-row update
 * a caller would read as success.
 */
export type ArtifactRepositoryPort = {
  /** Records the incomplete state. The record must be `reserved`. */
  reserve(record: ArtifactRecord, signal?: AbortSignal): Result<ArtifactWrite, ArtifactError>;

  /** `reserved` → `available`, once the bytes are verified and in place. */
  finalize(
    id: ArtifactId,
    finalizedAt: Timestamp,
    signal?: AbortSignal,
  ): Result<ArtifactWrite, ArtifactError>;

  /** `reserved` → `quarantined`, once the bytes are set aside for inspection. */
  quarantine(
    id: ArtifactId,
    finalizedAt: Timestamp,
    signal?: AbortSignal,
  ): Result<ArtifactWrite, ArtifactError>;

  get(id: ArtifactId): Result<ArtifactRecord | null, ArtifactError>;

  findByDigest(
    digest: ContentDigest,
    limit: number,
  ): Result<readonly ArtifactRecord[], ArtifactError>;

  listByInvocation(
    id: InvocationId,
    limit: number,
  ): Result<readonly ArtifactRecord[], ArtifactError>;

  /**
   * Which of these digests a record still references.
   *
   * The sweep's only reference question, asked in bounded batches so a machine
   * holding a hundred thousand blobs never builds one statement for all of
   * them.
   */
  referencedDigests(
    digests: readonly ContentDigest[],
  ): Result<ReadonlySet<ContentDigest>, ArtifactError>;
};

/** What a caller declares about bytes it is about to stream. */
export type ArtifactIngestRequest = {
  readonly artifactId: ArtifactId;
  readonly mediaType: string;
  readonly encoding: ArtifactEncoding;
  readonly sensitivity: ArtifactSensitivity;
  readonly origin: ArtifactOrigin;
  readonly invocationId: InvocationId | null;
  /**
   * How many bytes the caller says it will write.
   *
   * Enforced against the ceiling before anything is allocated, and against the
   * observed count before anything is finalized. A producer that miscounts is a
   * producer whose output is truncated somewhere, and accepting it silently is
   * how a partial write is presented as complete.
   */
  readonly declaredByteLength: number;
  /**
   * The digest the caller believes these bytes have, when it knows one.
   *
   * Checked against the streamed digest before anything is finalized, so a
   * producer that already hashed its own output finds out here rather than
   * after the bytes are stored under the wrong identity.
   */
  readonly expectedDigest?: ContentDigest;
  readonly content: AsyncIterable<Uint8Array>;
};

/**
 * What ingest produced.
 *
 * `deduplicated` says the bytes were already stored under this digest, so this
 * ingest wrote a record and no blob. `cancelledAfterCommit` mirrors the store's
 * contract: cancellation after `COMMIT` did not undo it.
 */
export type ArtifactIngestReceipt = {
  readonly record: ArtifactRecord;
  readonly deduplicated: boolean;
  readonly cancelledAfterCommit: boolean;
};

/** A bounded read, and where it actually landed. */
export type ArtifactRange = {
  readonly artifactId: ArtifactId;
  /** The offset the read began at. Always the requested one; never adjusted. */
  readonly offset: number;
  /** Bytes actually returned, which may be fewer than requested at the tail. */
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  /** Whether this read reached the artifact's last byte. */
  readonly endOfArtifact: boolean;
};

/** Why the sweep left bytes in place. Counted, never named. */
export const ARTIFACT_RETENTION_REASONS = [
  /** A record still references these bytes. */
  "referenced",
  /** Quarantined bytes whose record is still there to inspect them with. */
  "quarantined-for-inspection",
  /** In-flight bytes belonging to a run that is not this one. */
  "temporary-not-this-run",
  /** The sweep stopped at a bound before deciding. */
  "not-reached",
] as const;

export type ArtifactRetentionReason = (typeof ARTIFACT_RETENTION_REASONS)[number];

export type ArtifactRetentionCount = {
  readonly reason: ArtifactRetentionReason;
  readonly count: number;
};

/**
 * What one sweep did, in counts.
 *
 * Counts only: a digest is derived from content, and a report meant to be
 * loggable cannot carry one. Deleted, retained, and failed stay three separate
 * facts, because collapsing them is how a partial cleanup reads as a clean one.
 */
export type ArtifactSweepReport = {
  readonly examined: number;
  readonly deleted: number;
  readonly retained: readonly ArtifactRetentionCount[];
  readonly failed: number;
  readonly completeness: MeasurementCompleteness;
  readonly effect: EffectCertainty;
};

/** Entries one sweep will examine before reporting that it saw only part. */
export const MAX_SWEPT_BLOBS = 10_000;

/**
 * The public artifact boundary.
 *
 * Everything above `src/data/` reaches artifacts through this and through
 * nothing else — no SQL, no file handle, no path. Ingest and reads are
 * asynchronous because bytes are; the metadata reads are synchronous because a
 * transaction is.
 */
export type ArtifactStorePort = {
  /**
   * Streams bytes, verifies them, finalizes them, and commits the record.
   *
   * Metadata commits only after the bytes are safely finalized. A commit that
   * fails afterwards leaves finalized bytes nothing references, which is
   * exactly what the sweep collects.
   */
  ingest(
    request: ArtifactIngestRequest,
    signal?: AbortSignal,
  ): Promise<Result<ArtifactIngestReceipt, ArtifactError>>;

  get(id: ArtifactId): Result<ArtifactRecord | null, ArtifactError>;

  /** Every record sharing exact bytes. Distinct lineage, one digest. */
  findByDigest(
    digest: ContentDigest,
    limit: number,
  ): Result<readonly ArtifactRecord[], ArtifactError>;

  listByInvocation(
    id: InvocationId,
    limit: number,
  ): Result<readonly ArtifactRecord[], ArtifactError>;

  /**
   * Reads a bounded range, refusing an offset or length outside the artifact.
   *
   * Returns the actual offset and length. A short tail is reported as the
   * length it returned, never as the length that was asked for.
   */
  readRange(
    id: ArtifactId,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Result<ArtifactRange, ArtifactError>>;

  /** The first bytes of an artifact, bounded by {@link MAX_ARTIFACT_PREVIEW_BYTES}. */
  preview(
    id: ArtifactId,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Result<ArtifactRange, ArtifactError>>;

  /** Collects bytes this store wrote that no record references. */
  sweep(signal?: AbortSignal): Promise<ArtifactSweepReport>;
};

const artifactIdSchema = brandedString(artifactId);

const artifactSchema = z.object({
  artifactId: artifactIdSchema,
  digest: brandedString(contentDigest),
  mediaType: z.string().min(3).max(MAX_MEDIA_TYPE_LENGTH).regex(MEDIA_TYPE),
  encoding: z.literal(ARTIFACT_ENCODINGS),
  byteLength: z.int().min(0).max(MAX_ARTIFACT_BYTES),
  sensitivity: z.literal(ARTIFACT_SENSITIVITIES),
  origin: z.literal(ARTIFACT_ORIGINS),
  invocationId: brandedString(invocationId).nullable(),
  createdAt: timestampSchema,
  finalizedAt: timestampSchema.nullable(),
  availability: z.literal(ARTIFACT_AVAILABILITIES),
});

/**
 * Parses a stored row into a record, or reports why it is not one.
 *
 * The pairing the schema constrains is re-checked here rather than trusted:
 * `reserved` is the only state without a finalized time. A database this build
 * did not write is untrusted input like any other.
 */
export function parseArtifactRecord(value: unknown): Result<ArtifactRecord, readonly CodecIssue[]> {
  const parsed = artifactSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        code: issue.code,
      })),
    );
  }
  const record = parsed.data;
  if ((record.finalizedAt === null) !== (record.availability === "reserved")) {
    return err([{ path: "finalizedAt", code: "custom" }]);
  }
  return ok(record);
}

/** Whether an artifact's bytes may be read in its current state. */
export function isReadable(record: ArtifactRecord): boolean {
  return record.availability === "available";
}

export function isArtifactSensitivity(value: unknown): value is ArtifactSensitivity {
  return typeof value === "string" && (ARTIFACT_SENSITIVITIES as readonly string[]).includes(value);
}

export function isArtifactAvailability(value: unknown): value is ArtifactAvailability {
  return (
    typeof value === "string" && (ARTIFACT_AVAILABILITIES as readonly string[]).includes(value)
  );
}
