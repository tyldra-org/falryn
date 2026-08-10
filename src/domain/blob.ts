/**
 * The blob port, and the hasher the artifact store verifies bytes with.
 *
 * This is a second, narrow port rather than growth on {@link FileSystemPort},
 * and the separation is deliberate. That port is shallow on purpose — stat, one
 * directory, one entry, one link, no recursion — because every dangerous
 * decision in local-data removal has to be unit-testable without a disk. Adding
 * streamed writes, an atomic rename, and a positional read to it would drag
 * byte-level ingest into the module whose whole value is that it cannot delete
 * more than one entry.
 *
 * Three rules the types carry rather than document:
 *
 * - **No path crosses this port.** A {@link BlobLocation} names a scope and a
 *   content digest, or a scope and an artifact identity. Where those land on a
 *   disk is the adapter's business, which is what keeps a path out of every
 *   error, event, and diagnostic above it.
 * - **Finalize is one primitive with a destination.** Promoting verified bytes
 *   and quarantining unverified ones are the same atomic move to two different
 *   scopes. Two methods would be two chances for one of them to stop being
 *   atomic.
 * - **A failure is a code and an operation, never a message.** Platform error
 *   text embeds absolute paths and errno spellings; passing it through would
 *   put both into every diagnostic.
 */

import type { ArtifactId, ContentDigest } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * Where bytes live, addressed rather than pathed.
 *
 * `content` and `quarantine` are keyed by digest because that is what makes
 * exact bytes deduplicable and a quarantined copy findable. `temporary` is
 * keyed by artifact identity because in-flight bytes have no digest yet — that
 * is the entire reason they are in flight.
 */
export type BlobLocation =
  | { readonly scope: "content"; readonly digest: ContentDigest }
  | { readonly scope: "quarantine"; readonly digest: ContentDigest }
  | { readonly scope: "temporary"; readonly artifactId: ArtifactId };

export type BlobScope = BlobLocation["scope"];

export const BLOB_SCOPES: readonly BlobScope[] = ["content", "quarantine", "temporary"];

export const BLOB_OPERATIONS = [
  "allocate",
  "write",
  "close",
  "finalize",
  "read",
  "remove",
  "list",
] as const;

export type BlobOperation = (typeof BLOB_OPERATIONS)[number];

export const BLOB_ERROR_CODES = [
  "not-found",
  "already-exists",
  "permission-denied",
  "disk-full",
  "out-of-range",
  "io-failure",
  "unsupported",
  "cancelled",
] as const;

export type BlobErrorCode = (typeof BLOB_ERROR_CODES)[number];

export type BlobError = {
  readonly kind: "blob";
  readonly code: BlobErrorCode;
  readonly operation: BlobOperation;
  readonly scope: BlobScope;
};

/**
 * Streamed writes, one atomic move, bounded reads, and removal.
 *
 * Every method is asynchronous, because every one of them touches a device. A
 * write that is not followed by a `close` has not reached the device, and a
 * `finalize` before a `close` is a defect the adapter reports rather than
 * papers over.
 */
export type BlobStorePort = {
  /**
   * Creates an empty temporary blob, refusing to reopen one that exists.
   *
   * `already-exists` rather than truncation: an in-flight blob under the same
   * identity means two ingests are racing, and silently truncating one of them
   * is how a partial write becomes a complete-looking artifact.
   */
  allocate(location: BlobLocation, signal?: AbortSignal): Promise<Result<null, BlobError>>;

  /** Appends one chunk to an open temporary blob. */
  write(
    location: BlobLocation,
    chunk: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Result<null, BlobError>>;

  /** Flushes to the device and closes the handle. Idempotent. */
  close(location: BlobLocation, signal?: AbortSignal): Promise<Result<null, BlobError>>;

  /**
   * Atomically moves closed bytes to their destination scope.
   *
   * The rename is the commit point for the bytes: after it, either the whole
   * blob is at its destination or none of it is. Quarantining is this same
   * move with a `quarantine` destination.
   */
  finalize(
    source: BlobLocation,
    destination: BlobLocation,
    signal?: AbortSignal,
  ): Promise<Result<null, BlobError>>;

  /**
   * Reads at most `length` bytes from `offset`.
   *
   * Returns what it read, which is shorter than `length` at the tail. Reporting
   * a short tail as the requested length is how a truncated read is presented
   * as a whole one.
   */
  readRange(
    location: BlobLocation,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, BlobError>>;

  /** How many bytes a blob holds, or `null` when it is not there. */
  byteLength(
    location: BlobLocation,
    signal?: AbortSignal,
  ): Promise<Result<number | null, BlobError>>;

  /** Removes one blob. A blob that is not there is already removed. */
  remove(location: BlobLocation, signal?: AbortSignal): Promise<Result<null, BlobError>>;

  /** Every blob in one scope, bounded. The sweep's only way to see the disk. */
  list(
    scope: BlobScope,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Result<readonly BlobLocation[], BlobError>>;
};

/**
 * An incremental hash over streamed bytes.
 *
 * A port rather than a direct call, for two reasons: the domain names no host
 * API, and staging a hasher that reports the wrong digest is the only honest
 * way to test that a mismatch quarantines rather than deletes.
 */
export type ContentHasher = {
  update(chunk: Uint8Array): void;
  /** The digest of everything written so far. Called once, at the end. */
  digest(): ContentDigest;
};

export type ContentHasherPort = {
  create(): ContentHasher;
};

export type InMemoryBlobStoreOptions = {
  /** Operations to fail, with the code to fail them as. */
  readonly failOperations?: Partial<Record<BlobOperation, BlobErrorCode>>;
};

/** The key one location is held under. Exported so a test can stage bytes. */
export function blobKey(location: BlobLocation): string {
  return location.scope === "temporary"
    ? `temporary:${location.artifactId}`
    : `${location.scope}:${location.digest}`;
}

/**
 * An in-memory `BlobStorePort` for tests.
 *
 * Real enough to exercise the decisions that matter — an atomic move, a short
 * tail, bytes that changed after they were hashed, and a device that refuses
 * one operation — without a temporary directory. The adapter's own tests use a
 * real one.
 */
export function createInMemoryBlobStore(options: InMemoryBlobStoreOptions = {}): BlobStorePort & {
  /** Every location the double still holds, sorted by key. */
  locations(): readonly BlobLocation[];
  bytesAt(location: BlobLocation): Uint8Array | null;
  /** Replaces bytes in place, for staging content that changed underfoot. */
  put(location: BlobLocation, bytes: Uint8Array): void;
} {
  const blobs = new Map<string, { location: BlobLocation; bytes: Uint8Array; open: boolean }>();

  const injected = (operation: BlobOperation, scope: BlobScope): BlobError | null => {
    const code = options.failOperations?.[operation];
    return code === undefined ? null : { kind: "blob", code, operation, scope };
  };

  const fail = (
    code: BlobErrorCode,
    operation: BlobOperation,
    scope: BlobScope,
  ): Result<never, BlobError> => err({ kind: "blob", code, operation, scope });

  const guard = (
    operation: BlobOperation,
    scope: BlobScope,
    signal: AbortSignal | undefined,
  ): BlobError | null => {
    if (signal?.aborted === true) {
      return { kind: "blob", code: "cancelled", operation, scope };
    }
    return injected(operation, scope);
  };

  return {
    locations: () =>
      [...blobs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, entry]) => entry.location),

    bytesAt: (location) => blobs.get(blobKey(location))?.bytes ?? null,

    put(location, bytes) {
      blobs.set(blobKey(location), { location, bytes, open: false });
    },

    async allocate(location, signal) {
      const refused = guard("allocate", location.scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      const key = blobKey(location);
      if (blobs.has(key)) {
        return fail("already-exists", "allocate", location.scope);
      }
      blobs.set(key, { location, bytes: new Uint8Array(0), open: true });
      return ok(null);
    },

    async write(location, chunk, signal) {
      const refused = guard("write", location.scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      const entry = blobs.get(blobKey(location));
      if (entry === undefined || !entry.open) {
        return fail("not-found", "write", location.scope);
      }
      const grown = new Uint8Array(entry.bytes.byteLength + chunk.byteLength);
      grown.set(entry.bytes, 0);
      grown.set(chunk, entry.bytes.byteLength);
      entry.bytes = grown;
      return ok(null);
    },

    async close(location, signal) {
      const refused = guard("close", location.scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      const entry = blobs.get(blobKey(location));
      if (entry !== undefined) {
        entry.open = false;
      }
      return ok(null);
    },

    async finalize(source, destination, signal) {
      const refused = guard("finalize", destination.scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      const entry = blobs.get(blobKey(source));
      if (entry === undefined) {
        return fail("not-found", "finalize", destination.scope);
      }
      if (entry.open) {
        return fail("io-failure", "finalize", destination.scope);
      }
      blobs.delete(blobKey(source));
      // Whole or not at all: the destination appears with every byte the
      // source had, in one step.
      blobs.set(blobKey(destination), { location: destination, bytes: entry.bytes, open: false });
      return ok(null);
    },

    async readRange(location, offset, length, signal) {
      const refused = guard("read", location.scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      if (offset < 0 || length < 0) {
        return fail("out-of-range", "read", location.scope);
      }
      const entry = blobs.get(blobKey(location));
      if (entry === undefined) {
        return fail("not-found", "read", location.scope);
      }
      return ok(entry.bytes.slice(offset, offset + length));
    },

    async byteLength(location, signal) {
      const refused = guard("read", location.scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      const entry = blobs.get(blobKey(location));
      return ok(entry === undefined ? null : entry.bytes.byteLength);
    },

    async remove(location, signal) {
      const refused = guard("remove", location.scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      blobs.delete(blobKey(location));
      return ok(null);
    },

    async list(scope, limit, signal) {
      const refused = guard("list", scope, signal);
      if (refused !== null) {
        return err(refused);
      }
      const matching = [...blobs.values()]
        .filter((entry) => entry.location.scope === scope)
        .map((entry) => entry.location);
      return ok(matching.slice(0, limit));
    },
  };
}
