/**
 * The host export-package adapter.
 *
 * The one module that writes an export package. It translates `node:fs`
 * results and errno strings into `PackageWriterPort` and owns the only thing
 * above it never sees: where a package actually lives.
 *
 * Three translation choices worth stating:
 *
 * - **Staged beside its destination, never elsewhere.** The staged name sits in
 *   the same directory as the final one, so publishing is a rename within one
 *   filesystem and is therefore atomic. A staging area on another volume would
 *   turn the publish into a copy, which is exactly the moment a half-written
 *   package could appear.
 * - **A visible suffix, not a hidden directory.** An interrupted export leaves
 *   `<name>.partial`, which reads as what it is. Hiding it would make an
 *   abandoned export look like free disk that vanished.
 * - **Free space is reported, or reported as unknown.** `statfs` is not
 *   available everywhere; where it is not, the answer is `null` rather than a
 *   guess, because a guess would either refuse every export or promise space
 *   nobody confirmed.
 */

import {
  type FileHandle,
  constants as fsConstants,
  mkdir,
  open,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";

import {
  type ExportName,
  err,
  joinPath,
  type LocalPath,
  ok,
  type PackageError,
  type PackageErrorCode,
  type PackageOperation,
  type PackageWriterPort,
  type Result,
} from "../domain/index.ts";

/** Directory bits the exports root is created with. Owner-only. */
const PRIVATE_DIRECTORY_MODE = 0o700;

/** Bits a package file is created with. A package is a user's content. */
const PRIVATE_FILE_MODE = 0o600;

/** What an unfinished package is called, so it reads as unfinished. */
export const STAGED_SUFFIX = ".partial";

/** errno spellings this adapter recognizes. Anything else is `io-failure`. */
const ERRNO_CODES: Readonly<Record<string, PackageErrorCode>> = {
  ENOENT: "not-found",
  EEXIST: "already-exists",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  EROFS: "permission-denied",
  ENOSPC: "disk-full",
  EDQUOT: "disk-full",
  EFBIG: "disk-full",
  EISDIR: "io-failure",
  ENOTDIR: "io-failure",
  ENOSYS: "unsupported",
};

function errnoOf(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null) {
    return null;
  }
  const code = (thrown as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function failure(code: PackageErrorCode, operation: PackageOperation): PackageError {
  return { kind: "package", code, operation };
}

function translate(thrown: unknown, operation: PackageOperation): PackageError {
  const errno = errnoOf(thrown);
  return failure(errno === null ? "io-failure" : (ERRNO_CODES[errno] ?? "io-failure"), operation);
}

export type HostPackageWriterOptions = {
  /** The `exports` root. Packages and their staged forms live directly in it. */
  readonly exportsRoot: LocalPath;
};

export function createHostPackageWriter(options: HostPackageWriterOptions): PackageWriterPort {
  const handles = new Map<string, FileHandle>();

  const pathFor = (name: ExportName, staged: boolean): LocalPath | null => {
    const joined = joinPath(options.exportsRoot, staged ? `${name}${STAGED_SUFFIX}` : name);
    return joined.ok ? joined.value : null;
  };

  const cancelled = (operation: PackageOperation): Result<never, PackageError> =>
    err(failure("cancelled", operation));

  const unresolved = (operation: PackageOperation): Result<never, PackageError> =>
    err(failure("io-failure", operation));

  return {
    async begin(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>> {
      if (signal?.aborted === true) {
        return cancelled("begin");
      }
      const staged = pathFor(name, true);
      const destination = pathFor(name, false);
      if (staged === null || destination === null) {
        return unresolved("begin");
      }
      if (handles.has(name)) {
        return err(failure("already-exists", "begin"));
      }
      try {
        await mkdir(options.exportsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        // Checked before staging: overwriting a package the user asked for is
        // destroying an export to make room for an export.
        const existing = await stat(destination).catch(() => null);
        if (existing !== null) {
          return err(failure("already-exists", "begin"));
        }
        // `wx` refuses an existing staged file too, so two exports under one
        // name cannot interleave their bytes.
        handles.set(name, await open(staged, "wx", PRIVATE_FILE_MODE));
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "begin"));
      }
    },

    async write(
      name: ExportName,
      chunk: Uint8Array,
      signal?: AbortSignal,
    ): Promise<Result<null, PackageError>> {
      if (signal?.aborted === true) {
        return cancelled("write");
      }
      const handle = handles.get(name);
      if (handle === undefined) {
        return err(failure("not-found", "write"));
      }
      try {
        await handle.write(chunk);
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "write"));
      }
    },

    async close(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>> {
      const handle = handles.get(name);
      if (handle === undefined) {
        return ok(null);
      }
      handles.delete(name);
      try {
        // Flushed before the handle goes: a rename moves a directory entry, not
        // the page cache, so bytes that never reached the device would publish
        // as a package that is not all there.
        await handle.sync();
        await handle.close();
        return signal?.aborted === true ? cancelled("close") : ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "close"));
      }
    },

    async finalize(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>> {
      if (signal?.aborted === true) {
        return cancelled("finalize");
      }
      if (handles.has(name)) {
        // Publishing before closing would move bytes that are still buffered.
        return err(failure("io-failure", "finalize"));
      }
      const staged = pathFor(name, true);
      const destination = pathFor(name, false);
      if (staged === null || destination === null) {
        return unresolved("finalize");
      }
      try {
        await rename(staged, destination);
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "finalize"));
      }
    },

    async discard(name: ExportName, signal?: AbortSignal): Promise<Result<null, PackageError>> {
      const staged = pathFor(name, true);
      if (staged === null) {
        return unresolved("discard");
      }
      const handle = handles.get(name);
      handles.delete(name);
      await handle?.close().catch(() => undefined);
      try {
        // `force` because a staged package that is not there is already
        // discarded, and never `recursive`: this adapter deletes one file.
        await rm(staged, { force: true, recursive: false });
        return signal?.aborted === true ? cancelled("discard") : ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "discard"));
      }
    },

    async readRange(
      name: ExportName,
      offset: number,
      length: number,
      signal?: AbortSignal,
    ): Promise<Result<Uint8Array, PackageError>> {
      if (signal?.aborted === true) {
        return cancelled("read");
      }
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        return err(failure("out-of-range", "read"));
      }
      const destination = pathFor(name, false);
      if (destination === null) {
        return unresolved("read");
      }
      let handle: FileHandle | null = null;
      try {
        handle = await open(destination, fsConstants.O_RDONLY);
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        // Sliced to what was read: handing back the tail of an over-allocated
        // buffer would report zeros as package content.
        return ok(buffer.subarray(0, bytesRead));
      } catch (thrown: unknown) {
        return err(translate(thrown, "read"));
      } finally {
        await handle?.close();
      }
    },

    async byteLength(
      name: ExportName,
      signal?: AbortSignal,
    ): Promise<Result<number | null, PackageError>> {
      if (signal?.aborted === true) {
        return cancelled("read");
      }
      const destination = pathFor(name, false);
      if (destination === null) {
        return unresolved("read");
      }
      try {
        const stats = await stat(destination);
        return ok(stats.isFile() ? stats.size : null);
      } catch (thrown: unknown) {
        // Missing is an answer, not a failure: a caller asks "is this package
        // there" before deciding what to do.
        return errnoOf(thrown) === "ENOENT" ? ok(null) : err(translate(thrown, "read"));
      }
    },

    async availableBytes(signal?: AbortSignal): Promise<Result<number | null, PackageError>> {
      if (signal?.aborted === true) {
        return cancelled("space");
      }
      try {
        await mkdir(options.exportsRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        const stats = await statfs(options.exportsRoot);
        return ok(Number(stats.bavail) * Number(stats.bsize));
      } catch {
        // Not every platform answers this. `null` says so, rather than
        // reporting a number nobody measured.
        return ok(null);
      }
    },
  };
}
