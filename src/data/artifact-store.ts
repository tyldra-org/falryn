/**
 * Artifact ingest, integrity, reads, and this store's own cleanup.
 *
 * One pipeline, in the order the architecture states it:
 *
 * ```text
 * allocate temp → stream bytes and hash → flush and close → atomic finalize
 *              → commit metadata → available
 * ```
 *
 * Six rules the implementation carries rather than documents:
 *
 * - **Both byte counts are enforced, and neither is trusted.** The declared
 *   length is checked against the configured ceiling before a byte is written,
 *   and against the observed count before anything is finalized. A producer
 *   that miscounts is a producer whose output was truncated somewhere; storing
 *   it anyway is how a partial write becomes a complete-looking artifact.
 * - **The digest is verified against the bytes that landed, not the bytes that
 *   were offered.** After the atomic move, the finalized blob is re-read and
 *   re-hashed. Hashing the stream alone proves what was in memory; this proves
 *   what is on the device, which is the only claim a store is entitled to make.
 * - **A mismatch quarantines and never deletes.** Bytes that failed to verify
 *   are the evidence of whatever went wrong. The record moves to `quarantined`
 *   beside them so there is something to inspect them with.
 * - **Metadata is committed twice, on purpose.** A `reserved` row is written
 *   before the bytes move and moved to `available` only after they verify, so a
 *   run that dies between the two leaves a row that says exactly that. The
 *   alternative — one commit at the end — leaves finalized bytes with nothing
 *   describing them.
 * - **Cancellation keeps its meaning.** Checked at every stage; before the
 *   final commit it is `cancelled`, and after it the commit stands and the
 *   cancellation is reported beside the committed value.
 * - **Nothing here names a path.** Bytes are addressed by scope and digest
 *   through `BlobStorePort`, so no path, digest, or byte reaches an error, an
 *   event, or a diagnostic.
 */

import {
  type ArtifactAvailability,
  type ArtifactEncoding,
  type ArtifactError,
  type ArtifactId,
  type ArtifactIngestReceipt,
  type ArtifactIngestRequest,
  type ArtifactOrigin,
  type ArtifactRange,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type ArtifactRetentionCount,
  type ArtifactRetentionReason,
  type ArtifactSensitivity,
  type ArtifactStorePort,
  type ArtifactSweepReport,
  type BlobError,
  type BlobLocation,
  type BlobStorePort,
  type ClockPort,
  type ContentDigest,
  type ContentHasherPort,
  DEFAULT_ARTIFACT_MAX_BYTES,
  type EffectCertainty,
  err,
  type InvocationId,
  isReadable,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_PREVIEW_BYTES,
  MAX_ARTIFACT_RANGE_BYTES,
  MAX_SWEPT_BLOBS,
  type MeasurementCompleteness,
  ok,
  parseArtifactRecord,
  type Result,
  type ShutdownParticipant,
  type Timestamp,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";

/** The `finalize-artifacts` participant's name, reported when it does not finish. */
export const ARTIFACT_PARTICIPANT_NAME = "artifact-store";

/** How much of a finalized blob one verification pass reads at a time. */
export const VERIFICATION_CHUNK_BYTES = 1_024 * 1_024;

export type ArtifactStoreOptions = {
  readonly repository: ArtifactRepositoryPort;
  readonly blobs: BlobStorePort;
  readonly hasher: ContentHasherPort;
  readonly clock: ClockPort;
  /**
   * The configured per-artifact ceiling.
   *
   * Bounded by {@link MAX_ARTIFACT_BYTES} here rather than trusted, because a
   * ceiling above the declared hard bound would let a caller ask for a read
   * this build has no bound for.
   */
  readonly maxArtifactBytes?: number;
};

export type DurableArtifactStore = ArtifactStorePort & {
  /**
   * Stops accepting ingest, awaits what is in flight, and discards the
   * temporary bytes this run allocated and never finalized.
   *
   * Safe to delete precisely because they are *this run's*: the store knows it
   * abandoned them, which is the thing startup reconciliation can never know
   * about a file it merely found.
   */
  quiesce(signal?: AbortSignal): Promise<void>;

  isAccepting(): boolean;
};

function blobFailure(error: BlobError, id: ArtifactId | null): ArtifactError {
  return { kind: "artifact", code: "storage", failure: { medium: "bytes", error }, artifactId: id };
}

function temporary(id: ArtifactId): BlobLocation {
  return { scope: "temporary", artifactId: id };
}

function content(digest: ContentDigest): BlobLocation {
  return { scope: "content", digest };
}

function quarantined(digest: ContentDigest): BlobLocation {
  return { scope: "quarantine", digest };
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** What a proposed record carries before its bytes have a digest. */
type IngestMetadata = {
  readonly mediaType: string;
  readonly encoding: ArtifactEncoding;
  readonly sensitivity: ArtifactSensitivity;
  readonly origin: ArtifactOrigin;
  readonly invocationId: InvocationId | null;
};

function proposedRecord(
  request: ArtifactIngestRequest,
  metadata: IngestMetadata,
  digest: ContentDigest,
  byteLength: number,
  createdAt: Timestamp,
): ArtifactRecord {
  return {
    artifactId: request.artifactId,
    digest,
    mediaType: metadata.mediaType,
    encoding: metadata.encoding,
    byteLength,
    sensitivity: metadata.sensitivity,
    origin: metadata.origin,
    invocationId: metadata.invocationId,
    createdAt,
    finalizedAt: null,
    availability: "reserved",
  };
}

function finalizedRecord(
  record: ArtifactRecord,
  at: Timestamp,
  availability: ArtifactAvailability,
): ArtifactRecord {
  return { ...record, finalizedAt: at, availability };
}

export function createArtifactStore(options: ArtifactStoreOptions): DurableArtifactStore {
  const { repository, blobs, hasher, clock } = options;
  const ceiling = Math.min(
    options.maxArtifactBytes ?? DEFAULT_ARTIFACT_MAX_BYTES,
    MAX_ARTIFACT_BYTES,
  );

  let accepting = true;
  const inFlight = new Set<Promise<unknown>>();
  /** Temporary blobs this run allocated and has not released. */
  const openTemporaries = new Set<ArtifactId>();

  const now = (): Timestamp => timestampFromEpochMilliseconds(clock.now());

  const releaseTemporary = async (id: ArtifactId, signal?: AbortSignal): Promise<void> => {
    openTemporaries.delete(id);
    // Best effort by construction: the caller is already reporting a failure,
    // and a leftover temporary is exactly what the sweep and startup
    // reconciliation exist to see. Replacing that failure with this one would
    // hide the reason the ingest stopped.
    await blobs.remove(temporary(id), signal);
  };

  async function performIngest(
    request: ArtifactIngestRequest,
    signal?: AbortSignal,
  ): Promise<Result<ArtifactIngestReceipt, ArtifactError>> {
    const id = request.artifactId;
    if (aborted(signal)) {
      return err({ kind: "artifact", code: "cancelled", artifactId: id });
    }

    const declared = request.declaredByteLength;
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return err({
        kind: "artifact",
        code: "size-mismatch",
        artifactId: id,
        declaredByteLength: declared,
        observedByteLength: 0,
      });
    }
    if (declared > ceiling) {
      return err({
        kind: "artifact",
        code: "oversize",
        artifactId: id,
        requestedByteLength: declared,
        maximumByteLength: ceiling,
      });
    }

    const metadata: IngestMetadata = {
      mediaType: request.mediaType,
      encoding: request.encoding,
      sensitivity: request.sensitivity,
      origin: request.origin,
      invocationId: request.invocationId,
    };

    const allocated = await blobs.allocate(temporary(id), signal);
    if (!allocated.ok) {
      return err(blobFailure(allocated.error, id));
    }
    openTemporaries.add(id);

    const digesting = hasher.create();
    let observed = 0;

    for await (const chunk of request.content) {
      if (aborted(signal)) {
        await releaseTemporary(id);
        return err({ kind: "artifact", code: "cancelled", artifactId: id });
      }
      observed += chunk.byteLength;
      if (observed > declared) {
        // Stopped at the first byte past the declaration rather than after the
        // whole stream: a producer that overruns its own count may not stop.
        await releaseTemporary(id, signal);
        return err({
          kind: "artifact",
          code: "size-mismatch",
          artifactId: id,
          declaredByteLength: declared,
          observedByteLength: observed,
        });
      }
      const written = await blobs.write(temporary(id), chunk, signal);
      if (!written.ok) {
        await releaseTemporary(id);
        return err(blobFailure(written.error, id));
      }
      digesting.update(chunk);
    }

    const closed = await blobs.close(temporary(id), signal);
    if (!closed.ok) {
      await releaseTemporary(id);
      return err(blobFailure(closed.error, id));
    }

    if (observed !== declared) {
      await releaseTemporary(id, signal);
      return err({
        kind: "artifact",
        code: "size-mismatch",
        artifactId: id,
        declaredByteLength: declared,
        observedByteLength: observed,
      });
    }

    const digest = digesting.digest();
    const record = proposedRecord(request, metadata, digest, observed, now());
    // Validated before it reaches SQL, so a malformed media type is reported as
    // a path and an issue code rather than as a constraint the caller would
    // have to interpret.
    const validated = parseArtifactRecord(record);
    if (!validated.ok) {
      await releaseTemporary(id, signal);
      return err({ kind: "artifact", code: "malformed-row", issues: validated.error });
    }

    if (aborted(signal)) {
      await releaseTemporary(id);
      return err({ kind: "artifact", code: "cancelled", artifactId: id });
    }

    // The caller hashed its own output and the two do not agree. Nothing has
    // been finalized, so the bytes go to quarantine rather than to content and
    // the record says why they are there.
    if (request.expectedDigest !== undefined && request.expectedDigest !== digest) {
      return await setAside(record, signal);
    }

    const existing = await blobs.byteLength(content(digest), signal);
    if (!existing.ok) {
      await releaseTemporary(id);
      return err(blobFailure(existing.error, id));
    }

    if (existing.value !== null) {
      // Exact bytes already stored. The blob is shared; the records are not.
      await releaseTemporary(id, signal);
      return await commit(record, true, signal);
    }

    const reserved = repository.reserve(record, signal);
    if (!reserved.ok) {
      await releaseTemporary(id, signal);
      return err(reserved.error);
    }
    openTemporaries.delete(id);

    const finalized = await blobs.finalize(temporary(id), content(digest), signal);
    if (!finalized.ok) {
      return err(blobFailure(finalized.error, id));
    }

    const verified = await verify(digest, observed, signal);
    if (!verified.ok) {
      return err(verified.error);
    }
    if (!verified.value) {
      const setAsideBytes = await blobs.finalize(content(digest), quarantined(digest), signal);
      if (!setAsideBytes.ok) {
        return err(blobFailure(setAsideBytes.error, id));
      }
      const marked = repository.quarantine(id, now(), signal);
      return marked.ok
        ? err({ kind: "artifact", code: "digest-mismatch", artifactId: id })
        : err(marked.error);
    }

    const at = now();
    const committed = repository.finalize(id, at, signal);
    if (!committed.ok) {
      return err(committed.error);
    }
    return ok({
      record: finalizedRecord(record, at, "available"),
      deduplicated: false,
      cancelledAfterCommit: committed.value.cancelledAfterCommit,
    });
  }

  /** Reserves and immediately finalizes a record whose bytes are already there. */
  async function commit(
    record: ArtifactRecord,
    deduplicated: boolean,
    signal?: AbortSignal,
  ): Promise<Result<ArtifactIngestReceipt, ArtifactError>> {
    const reserved = repository.reserve(record, signal);
    if (!reserved.ok) {
      return err(reserved.error);
    }
    const at = now();
    const committed = repository.finalize(record.artifactId, at, signal);
    if (!committed.ok) {
      return err(committed.error);
    }
    return ok({
      record: finalizedRecord(record, at, "available"),
      deduplicated,
      cancelledAfterCommit: committed.value.cancelledAfterCommit,
    });
  }

  /** Moves unverified bytes to quarantine and records why they are there. */
  async function setAside(
    record: ArtifactRecord,
    signal?: AbortSignal,
  ): Promise<Result<ArtifactIngestReceipt, ArtifactError>> {
    const id = record.artifactId;
    const reserved = repository.reserve(record, signal);
    if (!reserved.ok) {
      await releaseTemporary(id, signal);
      return err(reserved.error);
    }
    openTemporaries.delete(id);

    const moved = await blobs.finalize(temporary(id), quarantined(record.digest), signal);
    if (!moved.ok) {
      return err(blobFailure(moved.error, id));
    }
    const marked = repository.quarantine(id, now(), signal);
    return marked.ok
      ? err({ kind: "artifact", code: "digest-mismatch", artifactId: id })
      : err(marked.error);
  }

  /** Re-reads finalized bytes and re-hashes them. `false` means they changed. */
  async function verify(
    digest: ContentDigest,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<Result<boolean, ArtifactError>> {
    const rehashing = hasher.create();
    let offset = 0;
    while (offset < byteLength) {
      if (aborted(signal)) {
        return err({ kind: "artifact", code: "cancelled", artifactId: null });
      }
      const length = Math.min(VERIFICATION_CHUNK_BYTES, byteLength - offset);
      const read = await blobs.readRange(content(digest), offset, length, signal);
      if (!read.ok) {
        return err(blobFailure(read.error, null));
      }
      if (read.value.byteLength === 0) {
        // Fewer bytes on the device than the record claims. Advancing by the
        // requested length would loop forever, and the answer is already known.
        return ok(false);
      }
      rehashing.update(read.value);
      // Advanced by what was read, not by what was asked for, so a short read
      // resumes where it stopped instead of skipping the bytes it did not get.
      offset += read.value.byteLength;
    }
    return ok(rehashing.digest() === digest);
  }

  async function read(
    id: ArtifactId,
    offset: number,
    length: number,
    signal: AbortSignal | undefined,
    maximumLength: number,
  ): Promise<Result<ArtifactRange, ArtifactError>> {
    if (aborted(signal)) {
      return err({ kind: "artifact", code: "cancelled", artifactId: id });
    }
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) {
      return err({
        kind: "artifact",
        code: "oversize",
        artifactId: id,
        requestedByteLength: length,
        maximumByteLength: maximumLength,
      });
    }

    const found = repository.get(id);
    if (!found.ok) {
      return err(found.error);
    }
    const record = found.value;
    if (record === null) {
      return err({ kind: "artifact", code: "not-found", artifactId: id });
    }
    if (!isReadable(record)) {
      return err({
        kind: "artifact",
        code: "unavailable-bytes",
        artifactId: id,
        availability: record.availability,
      });
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.byteLength) {
      return err({
        kind: "artifact",
        code: "range-out-of-bounds",
        artifactId: id,
        requestedOffset: offset,
        requestedLength: length,
        byteLength: record.byteLength,
      });
    }

    const bounded = Math.min(length, record.byteLength - offset);
    if (bounded === 0) {
      return ok({
        artifactId: id,
        offset,
        byteLength: 0,
        bytes: new Uint8Array(0),
        endOfArtifact: offset >= record.byteLength,
      });
    }

    const bytes = await blobs.readRange(content(record.digest), offset, bounded, signal);
    if (!bytes.ok) {
      return err(blobFailure(bytes.error, id));
    }
    return ok({
      artifactId: id,
      offset,
      byteLength: bytes.value.byteLength,
      bytes: bytes.value,
      endOfArtifact: offset + bytes.value.byteLength >= record.byteLength,
    });
  }

  return {
    async ingest(
      request: ArtifactIngestRequest,
      signal?: AbortSignal,
    ): Promise<Result<ArtifactIngestReceipt, ArtifactError>> {
      if (!accepting) {
        // Quiesced by the `finalize-artifacts` phase. A late ingest did not
        // commit, which is exactly what `cancelled` means here.
        return err({ kind: "artifact", code: "cancelled", artifactId: request.artifactId });
      }
      const pending = performIngest(request, signal);
      inFlight.add(pending);
      try {
        return await pending;
      } finally {
        inFlight.delete(pending);
      }
    },

    get: (id) => repository.get(id),
    findByDigest: (digest, limit) => repository.findByDigest(digest, limit),
    listByInvocation: (id, limit) => repository.listByInvocation(id, limit),

    readRange: (id, offset, length, signal) =>
      read(id, offset, length, signal, MAX_ARTIFACT_RANGE_BYTES),

    preview: (id, maximumBytes, signal) =>
      read(id, 0, maximumBytes, signal, MAX_ARTIFACT_PREVIEW_BYTES),

    sweep: (signal) => sweep(repository, blobs, signal),

    async quiesce(signal?: AbortSignal): Promise<void> {
      accepting = false;
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      for (const id of [...openTemporaries]) {
        openTemporaries.delete(id);
        await blobs.remove(temporary(id), signal);
      }
    },

    isAccepting: () => accepting,
  };
}

/**
 * Collects bytes this store wrote that no record references.
 *
 * Mark, recheck, delete — in that order, and the recheck is the point. Between
 * listing the blobs and deleting one, an ingest can commit a record that
 * references it, and deleting on the strength of the first answer alone is how
 * a live artifact loses its bytes.
 *
 * Quarantined bytes are deleted only when no record mentions their digest at
 * all. Bytes kept for inspection with nothing to inspect them with are just
 * bytes; bytes kept beside the record that explains them are evidence.
 */
async function sweep(
  repository: ArtifactRepositoryPort,
  blobs: BlobStorePort,
  signal?: AbortSignal,
): Promise<ArtifactSweepReport> {
  const retained = new Map<ArtifactRetentionReason, number>();
  let examined = 0;
  let deleted = 0;
  let failed = 0;
  let completeness: MeasurementCompleteness = "complete";

  const retain = (reason: ArtifactRetentionReason, count = 1): void => {
    retained.set(reason, (retained.get(reason) ?? 0) + count);
  };

  const digestsIn = async (scope: "content" | "quarantine"): Promise<readonly ContentDigest[]> => {
    const listed = await blobs.list(scope, MAX_SWEPT_BLOBS, signal);
    if (!listed.ok) {
      completeness = "partial";
      return [];
    }
    if (listed.value.length >= MAX_SWEPT_BLOBS) {
      completeness = "partial";
    }
    return listed.value.flatMap((location) =>
      location.scope === "temporary" ? [] : [location.digest],
    );
  };

  const collect = async (
    scope: "content" | "quarantine",
    keepReason: ArtifactRetentionReason,
  ): Promise<void> => {
    if (aborted(signal)) {
      completeness = "partial";
      return;
    }
    const present = await digestsIn(scope);
    examined += present.length;

    const referenced = repository.referencedDigests(present);
    if (!referenced.ok) {
      completeness = "partial";
      retain("not-reached", present.length);
      return;
    }
    const candidates = present.filter((digest) => !referenced.value.has(digest));
    retain(keepReason, present.length - candidates.length);

    // The recheck. A record committed since the first answer keeps its bytes.
    const stillUnreferenced = repository.referencedDigests(candidates);
    if (!stillUnreferenced.ok) {
      completeness = "partial";
      retain("not-reached", candidates.length);
      return;
    }

    for (const digest of candidates) {
      if (aborted(signal)) {
        completeness = "partial";
        retain("not-reached");
        continue;
      }
      if (stillUnreferenced.value.has(digest)) {
        retain(keepReason);
        continue;
      }
      const removed = await blobs.remove({ scope, digest }, signal);
      if (removed.ok) {
        deleted += 1;
      } else {
        failed += 1;
      }
    }
  };

  await collect("content", "referenced");
  await collect("quarantine", "quarantined-for-inspection");

  // Temporary bytes belong to whichever run allocated them. This run's are
  // discarded by the `finalize-artifacts` participant, which knows it abandoned
  // them; another run's are reported and left alone, because whether they
  // represent finished work is knowable only by their owner.
  const temporaries = await blobs.list("temporary", MAX_SWEPT_BLOBS, signal);
  if (temporaries.ok) {
    retain("temporary-not-this-run", temporaries.value.length);
  } else {
    completeness = "partial";
  }

  return {
    examined,
    deleted,
    retained: [...retained].map(([reason, count]): ArtifactRetentionCount => ({ reason, count })),
    failed,
    completeness,
    effect: sweepEffect(deleted, failed),
  };
}

function sweepEffect(deleted: number, failed: number): EffectCertainty {
  if (deleted === 0) {
    return "none";
  }
  return failed === 0 ? "completed" : "partial";
}

/**
 * The `finalize-artifacts` participant.
 *
 * Real work, and its position in the phase order is the point: it runs before
 * `persist-outcomes`, so an artifact that was still streaming when shutdown
 * began has either finished and committed its record or been abandoned and had
 * its temporary bytes discarded, before anything downstream tries to persist an
 * outcome that references it.
 */
export function createArtifactShutdownParticipant(
  store: DurableArtifactStore,
): ShutdownParticipant {
  return {
    name: ARTIFACT_PARTICIPANT_NAME,
    phase: "finalize-artifacts",
    async run(context): Promise<void> {
      await store.quiesce(context.signal);
    },
  };
}
