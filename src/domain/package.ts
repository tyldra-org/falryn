/**
 * The export package port.
 *
 * A third narrow byte port, beside `FileSystemPort` and `BlobStorePort`, and
 * separate from both for the reason each of those is separate: a package is
 * staged, streamed, finalized atomically, and read back, and none of that
 * belongs in the shallow port whose value is that it cannot delete more than
 * one entry, nor in the port that addresses content by digest — a package has
 * no digest until it is finished.
 *
 * Three rules the types carry rather than document:
 *
 * - **No filesystem path crosses this port.** A package is named, and where
 *   that name lands is the adapter's business. A path in a domain contract is a
 *   path in every error and diagnostic above it.
 * - **Staging and finalizing are separate operations.** A package that failed
 *   or was cancelled must never be left where a finished one would be, so the
 *   bytes accumulate somewhere else and one atomic move publishes them.
 * - **Free space is asked for, never assumed.** A writer that discovers a full
 *   disk halfway through has already spent the time it was trying to save.
 */

import type { Brand } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";

/** A package's name. File-safe, because it becomes one. */
export type ExportName = Brand<string, "ExportName">;

export const PACKAGE_OPERATIONS = [
  "begin",
  "write",
  "close",
  "finalize",
  "discard",
  "read",
  "space",
] as const;

export type PackageOperation = (typeof PACKAGE_OPERATIONS)[number];

export const PACKAGE_ERROR_CODES = [
  "not-found",
  "already-exists",
  "permission-denied",
  "disk-full",
  "out-of-range",
  "io-failure",
  "unsupported",
  "cancelled",
] as const;

export type PackageErrorCode = (typeof PACKAGE_ERROR_CODES)[number];

export type PackageError = {
  readonly kind: "package";
  readonly code: PackageErrorCode;
  readonly operation: PackageOperation;
};

export type PackageWriterPort = {
  /**
   * Opens a staged package under a name, refusing one that already exists.
   *
   * `already-exists` rather than truncation, at the staged name and at the
   * final one: overwriting a package a user asked for is destroying an export
   * to make room for an export.
   */
  begin(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>>;

  write(
    name: ExportName,
    chunk: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Result<null, PackageError>>;

  /** Flushes to the device and closes the handle. Idempotent. */
  close(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>>;

  /** Atomically publishes a closed package under its final name. */
  finalize(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>>;

  /** Removes a staged package. What a failed or cancelled export leaves behind. */
  discard(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>>;

  /** Reads from a *finalized* package. Verification's only way in. */
  readRange(
    name: ExportName,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, PackageError>>;

  /** Bytes a finalized package holds, or `null` when there is none. */
  byteLength(name: ExportName, signal?: AbortSignal): Promise<Result<number | null, PackageError>>;

  /**
   * Bytes free where packages are written, or `null` where the platform will
   * not say.
   *
   * `null` is not zero and is not unlimited: it means the check cannot be made,
   * and a caller that treated it as either would refuse every export or promise
   * space it never confirmed.
   */
  availableBytes(signal?: AbortSignal): Promise<Result<number | null, PackageError>>;
};

export type InMemoryPackageWriterOptions = {
  /** Operations to fail, with the code to fail them as. */
  readonly failOperations?: Partial<Record<PackageOperation, PackageErrorCode>>;
  /** Bytes the double reports free. `undefined` reports "will not say". */
  readonly availableBytes?: number;
};

/**
 * An in-memory `PackageWriterPort` for tests.
 *
 * Real enough to exercise the decisions that matter — an atomic publish, a
 * failed write leaving nothing at the destination, a truncated read, and a full
 * disk — without a temporary directory. The adapter's own tests use a real one.
 */
export function createInMemoryPackageWriter(
  options: InMemoryPackageWriterOptions = {},
): PackageWriterPort & {
  /** Names that have been published. Staged packages are not among them. */
  finalized(): readonly ExportName[];
  staged(): readonly ExportName[];
  bytesOf(name: ExportName): Uint8Array | null;
  /** Replaces a published package's bytes, for staging content that changed. */
  put(name: ExportName, bytes: Uint8Array): void;
} {
  const staging = new Map<string, { bytes: Uint8Array; open: boolean }>();
  const published = new Map<string, Uint8Array>();

  const injected = (operation: PackageOperation): PackageError | null => {
    const code = options.failOperations?.[operation];
    return code === undefined ? null : { kind: "package", code, operation };
  };

  const guard = (
    operation: PackageOperation,
    signal: AbortSignal | undefined,
  ): PackageError | null => {
    if (signal?.aborted === true) {
      return { kind: "package", code: "cancelled", operation };
    }
    return injected(operation);
  };

  const fail = (code: PackageErrorCode, operation: PackageOperation): Result<never, PackageError> =>
    err({ kind: "package", code, operation });

  return {
    finalized: () => [...published.keys()].sort() as ExportName[],
    staged: () => [...staging.keys()].sort() as ExportName[],
    bytesOf: (name) => published.get(name) ?? null,
    put(name, bytes) {
      published.set(name, bytes);
    },

    async begin(name, signal) {
      const refused = guard("begin", signal);
      if (refused !== null) {
        return err(refused);
      }
      if (staging.has(name) || published.has(name)) {
        return fail("already-exists", "begin");
      }
      staging.set(name, { bytes: new Uint8Array(0), open: true });
      return ok(null);
    },

    async write(name, chunk, signal) {
      const refused = guard("write", signal);
      if (refused !== null) {
        return err(refused);
      }
      const entry = staging.get(name);
      if (entry === undefined || !entry.open) {
        return fail("not-found", "write");
      }
      const grown = new Uint8Array(entry.bytes.byteLength + chunk.byteLength);
      grown.set(entry.bytes, 0);
      grown.set(chunk, entry.bytes.byteLength);
      entry.bytes = grown;
      return ok(null);
    },

    async close(name, signal) {
      const refused = guard("close", signal);
      if (refused !== null) {
        return err(refused);
      }
      const entry = staging.get(name);
      if (entry !== undefined) {
        entry.open = false;
      }
      return ok(null);
    },

    async finalize(name, signal) {
      const refused = guard("finalize", signal);
      if (refused !== null) {
        return err(refused);
      }
      const entry = staging.get(name);
      if (entry === undefined) {
        return fail("not-found", "finalize");
      }
      if (entry.open) {
        return fail("io-failure", "finalize");
      }
      staging.delete(name);
      // Whole or not at all: the published name appears with every byte the
      // staged one had, in one step.
      published.set(name, entry.bytes);
      return ok(null);
    },

    async discard(name, signal) {
      const refused = guard("discard", signal);
      if (refused !== null) {
        return err(refused);
      }
      staging.delete(name);
      return ok(null);
    },

    async readRange(name, offset, length, signal) {
      const refused = guard("read", signal);
      if (refused !== null) {
        return err(refused);
      }
      if (offset < 0 || length < 0) {
        return fail("out-of-range", "read");
      }
      const bytes = published.get(name);
      if (bytes === undefined) {
        return fail("not-found", "read");
      }
      return ok(bytes.slice(offset, offset + length));
    },

    async byteLength(name, signal) {
      const refused = guard("read", signal);
      if (refused !== null) {
        return err(refused);
      }
      return ok(published.get(name)?.byteLength ?? null);
    },

    async availableBytes(signal) {
      const refused = guard("space", signal);
      if (refused !== null) {
        return err(refused);
      }
      return ok(options.availableBytes ?? null);
    },
  };
}
