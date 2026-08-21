/**
 * The host blob adapter.
 *
 * The one module in the tree that writes artifact bytes. It translates
 * `node:fs` results and errno strings into `BlobStorePort` and owns the only
 * thing above it never sees: where a blob actually lives.
 *
 * Three translation choices worth stating:
 *
 * - **A location becomes a path here and nowhere else.** Content and quarantine
 *   are addressed by digest and sharded by its first two hexadecimal
 *   characters, so a directory holding a hundred thousand blobs is a hundred
 *   directories holding a thousand. In-flight bytes live in the temporary
 *   ingest root under a name the domain declares, which is what lets startup
 *   reconciliation say who owns an entry it finds.
 * - **Finalize is a rename, and stays atomic even across filesystems.** The
 *   temporary ingest root and the artifacts root can be on different volumes,
 *   where `rename` fails with `EXDEV`. The fallback copies to a scratch name
 *   *inside the destination directory* and renames from there, so the
 *   destination still appears whole or not at all.
 * - **An unrecognized errno becomes `io-failure`, never a message.** Platform
 *   error text embeds absolute paths and errno spellings that differ per OS;
 *   passing it through would put both into every diagnostic.
 */

import {
  copyFile,
  type FileHandle,
  constants as fsConstants,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";

import {
  type ArtifactId,
  artifactId,
  type BlobError,
  type BlobErrorCode,
  type BlobLocation,
  type BlobOperation,
  type BlobScope,
  type BlobStorePort,
  CONTENT_DIGEST_ALGORITHM,
  contentDigest,
  err,
  isTemporaryArtifactName,
  joinPath,
  type LocalPath,
  ok,
  type Result,
  TEMPORARY_ARTIFACT_PREFIX,
  TEMPORARY_ARTIFACT_SUFFIX,
  temporaryArtifactName,
} from "../domain/index.ts";

/** Directory bits every blob directory is created with. Owner-only. */
const PRIVATE_DIRECTORY_MODE = 0o700;

/** Bits a blob file is created with. A blob is a user's content. */
const PRIVATE_FILE_MODE = 0o600;

/** The digest prefix, and therefore how many characters the hexadecimal starts at. */
const DIGEST_PREFIX = `${CONTENT_DIGEST_ALGORITHM}:`;

/** How many leading hexadecimal characters name a shard directory. */
const SHARD_LENGTH = 2;

const CONTENT_DIRECTORY = "blobs";
const QUARANTINE_DIRECTORY = "quarantine";

/** errno spellings this adapter recognizes. Anything else is `io-failure`. */
const ERRNO_CODES: Readonly<Record<string, BlobErrorCode>> = {
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

function failure(code: BlobErrorCode, operation: BlobOperation, scope: BlobScope): BlobError {
  return { kind: "blob", code, operation, scope };
}

function translate(thrown: unknown, operation: BlobOperation, scope: BlobScope): BlobError {
  const errno = errnoOf(thrown);
  return failure(
    errno === null ? "io-failure" : (ERRNO_CODES[errno] ?? "io-failure"),
    operation,
    scope,
  );
}

export type HostBlobStoreOptions = {
  /** The `artifacts` root. Content and quarantine live beneath it. */
  readonly artifactsRoot: LocalPath;
  /** The `temporaryIngest` root. In-flight bytes live directly in it. */
  readonly temporaryRoot: LocalPath;
};

/** Where one location's bytes live, and which directory has to exist first. */
type ResolvedBlob = {
  readonly path: LocalPath;
  readonly directory: LocalPath;
};

export type HostBlobStore = BlobStorePort & {
  /**
   * Closes every open temporary handle without deleting files.
   *
   * Bun 1.4+ treats an unclosed `FileHandle` collected by GC as an error.
   * Call this from test teardown (or any abort path that abandons in-flight
   * bytes) so a store that still holds `wx` handles cannot trip the suite.
   */
  readonly releaseOpenHandles: () => Promise<void>;
};

export function createHostBlobStore(options: HostBlobStoreOptions): HostBlobStore {
  /** Open temporary handles, so a chunk write does not reopen the file. */
  const handles = new Map<string, FileHandle>();

  const releaseOpenHandles = async (): Promise<void> => {
    const open = [...handles.values()];
    handles.clear();
    await Promise.all(open.map((handle) => handle.close().catch(() => undefined)));
  };

  const hexOf = (digest: string): string => digest.slice(DIGEST_PREFIX.length);

  const resolve = (location: BlobLocation): ResolvedBlob | null => {
    if (location.scope === "temporary") {
      const path = joinPath(options.temporaryRoot, temporaryArtifactName(location.artifactId));
      return path.ok ? { path: path.value, directory: options.temporaryRoot } : null;
    }
    const hex = hexOf(location.digest);
    const root = location.scope === "content" ? CONTENT_DIRECTORY : QUARANTINE_DIRECTORY;
    const directory = joinPath(options.artifactsRoot, root, hex.slice(0, SHARD_LENGTH));
    if (!directory.ok) {
      return null;
    }
    const path = joinPath(directory.value, hex);
    return path.ok ? { path: path.value, directory: directory.value } : null;
  };

  const ensure = async (directory: LocalPath): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  };

  const keyOf = (id: ArtifactId): string => `temporary:${id}`;

  const unresolved = (operation: BlobOperation, scope: BlobScope): Result<never, BlobError> =>
    err(failure("io-failure", operation, scope));

  const cancelled = (operation: BlobOperation, scope: BlobScope): Result<never, BlobError> =>
    err(failure("cancelled", operation, scope));

  /** Every blob directory in one scope, so a listing can walk exactly two levels. */
  const shardDirectories = async (
    scope: "content" | "quarantine",
  ): Promise<readonly LocalPath[]> => {
    const root = joinPath(
      options.artifactsRoot,
      scope === "content" ? CONTENT_DIRECTORY : QUARANTINE_DIRECTORY,
    );
    if (!root.ok) {
      return [];
    }
    const entries = await readdir(root.value, { withFileTypes: true });
    const directories: LocalPath[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = joinPath(root.value, entry.name);
      if (child.ok) {
        directories.push(child.value);
      }
    }
    return directories;
  };

  return {
    releaseOpenHandles,

    async allocate(location: BlobLocation, signal?: AbortSignal): Promise<Result<null, BlobError>> {
      if (signal?.aborted === true) {
        return cancelled("allocate", location.scope);
      }
      const resolved = resolve(location);
      if (resolved === null || location.scope !== "temporary") {
        // Only in-flight bytes are allocated. Content and quarantine are
        // reached by finalizing, which is what keeps the move atomic.
        return unresolved("allocate", location.scope);
      }
      const key = keyOf(location.artifactId);
      if (handles.has(key)) {
        return err(failure("already-exists", "allocate", location.scope));
      }
      try {
        await ensure(resolved.directory);
        // `wx` refuses an existing file: two ingests under one identity means
        // one of them is about to have its bytes silently replaced.
        const handle = await open(resolved.path, "wx", PRIVATE_FILE_MODE);
        handles.set(key, handle);
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "allocate", location.scope));
      }
    },

    async write(
      location: BlobLocation,
      chunk: Uint8Array,
      signal?: AbortSignal,
    ): Promise<Result<null, BlobError>> {
      if (signal?.aborted === true) {
        return cancelled("write", location.scope);
      }
      if (location.scope !== "temporary") {
        return unresolved("write", location.scope);
      }
      const handle = handles.get(keyOf(location.artifactId));
      if (handle === undefined) {
        return err(failure("not-found", "write", location.scope));
      }
      try {
        await handle.write(chunk);
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "write", location.scope));
      }
    },

    async close(location: BlobLocation, signal?: AbortSignal): Promise<Result<null, BlobError>> {
      if (location.scope !== "temporary") {
        return unresolved("close", location.scope);
      }
      const key = keyOf(location.artifactId);
      const handle = handles.get(key);
      if (handle === undefined) {
        // Already closed. Closing twice is not a failure; leaving a handle open
        // would be.
        return ok(null);
      }
      handles.delete(key);
      try {
        // Flushed before the handle goes: a rename moves a directory entry, not
        // the page cache, so bytes that never reached the device would finalize
        // as an artifact that is not there.
        await handle.sync();
        await handle.close();
        return signal?.aborted === true ? cancelled("close", location.scope) : ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "close", location.scope));
      }
    },

    async finalize(
      source: BlobLocation,
      destination: BlobLocation,
      signal?: AbortSignal,
    ): Promise<Result<null, BlobError>> {
      if (signal?.aborted === true) {
        return cancelled("finalize", destination.scope);
      }
      if (source.scope === "temporary" && handles.has(keyOf(source.artifactId))) {
        // Finalizing before closing would move bytes that are still buffered.
        return err(failure("io-failure", "finalize", destination.scope));
      }
      const from = resolve(source);
      const to = resolve(destination);
      if (from === null || to === null) {
        return unresolved("finalize", destination.scope);
      }
      try {
        await ensure(to.directory);
        await rename(from.path, to.path);
        return ok(null);
      } catch (thrown: unknown) {
        if (errnoOf(thrown) !== "EXDEV") {
          return err(translate(thrown, "finalize", destination.scope));
        }
        return await crossDeviceFinalize(from.path, to, destination.scope);
      }
    },

    async readRange(
      location: BlobLocation,
      offset: number,
      length: number,
      signal?: AbortSignal,
    ): Promise<Result<Uint8Array, BlobError>> {
      if (signal?.aborted === true) {
        return cancelled("read", location.scope);
      }
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0
      ) {
        return err(failure("out-of-range", "read", location.scope));
      }
      const resolved = resolve(location);
      if (resolved === null) {
        return unresolved("read", location.scope);
      }
      let handle: FileHandle | null = null;
      try {
        handle = await open(resolved.path, fsConstants.O_RDONLY);
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        // Sliced to what was actually read: handing back the tail of an
        // over-allocated buffer would report zeros as content.
        return ok(buffer.subarray(0, bytesRead));
      } catch (thrown: unknown) {
        return err(translate(thrown, "read", location.scope));
      } finally {
        await handle?.close();
      }
    },

    async byteLength(
      location: BlobLocation,
      signal?: AbortSignal,
    ): Promise<Result<number | null, BlobError>> {
      if (signal?.aborted === true) {
        return cancelled("read", location.scope);
      }
      const resolved = resolve(location);
      if (resolved === null) {
        return unresolved("read", location.scope);
      }
      try {
        const stats = await stat(resolved.path);
        return ok(stats.isFile() ? stats.size : null);
      } catch (thrown: unknown) {
        // Missing is an answer, not a failure: every caller asks "are these
        // bytes already here" before deciding what to do.
        return errnoOf(thrown) === "ENOENT"
          ? ok(null)
          : err(translate(thrown, "read", location.scope));
      }
    },

    async remove(location: BlobLocation, signal?: AbortSignal): Promise<Result<null, BlobError>> {
      if (signal?.aborted === true) {
        return cancelled("remove", location.scope);
      }
      const resolved = resolve(location);
      if (resolved === null) {
        return unresolved("remove", location.scope);
      }
      if (location.scope === "temporary") {
        const key = keyOf(location.artifactId);
        const handle = handles.get(key);
        handles.delete(key);
        await handle?.close().catch(() => undefined);
      }
      try {
        // `force` because a blob that is not there is already removed, and
        // never `recursive`: this adapter deletes one file and can delete no
        // more than one however it is called.
        await rm(resolved.path, { force: true, recursive: false });
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, "remove", location.scope));
      }
    },

    async list(
      scope: BlobScope,
      limit: number,
      signal?: AbortSignal,
    ): Promise<Result<readonly BlobLocation[], BlobError>> {
      if (signal?.aborted === true) {
        return cancelled("list", scope);
      }
      if (!Number.isSafeInteger(limit) || limit < 1) {
        return err(failure("out-of-range", "list", scope));
      }
      try {
        return ok(
          scope === "temporary"
            ? await listTemporary(options.temporaryRoot, limit)
            : await listDigests(scope, limit, shardDirectories),
        );
      } catch (thrown: unknown) {
        // A scope directory that was never created holds nothing, and that is a
        // complete answer rather than a failure to look.
        return errnoOf(thrown) === "ENOENT" ? ok([]) : err(translate(thrown, "list", scope));
      }
    },
  };
}

/**
 * Finalizes onto a different filesystem without giving up atomicity.
 *
 * The copy lands on a scratch name inside the destination directory, is flushed
 * to the device, and is then renamed within that directory — so the destination
 * path still appears whole or not at all. The source is removed only after the
 * destination is durable; the reverse order loses the bytes if the machine
 * stops in between.
 */
async function crossDeviceFinalize(
  from: LocalPath,
  to: ResolvedBlob,
  scope: BlobScope,
): Promise<Result<null, BlobError>> {
  const scratch = joinPath(to.directory, `${basenameOf(to.path)}.incoming`);
  if (!scratch.ok) {
    return err(failure("io-failure", "finalize", scope));
  }
  try {
    await copyFile(from, scratch.value);
    const handle = await open(scratch.value, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(scratch.value, to.path);
    await rm(from, { force: true });
    return ok(null);
  } catch (thrown: unknown) {
    await rm(scratch.value, { force: true }).catch(() => undefined);
    return err(translate(thrown, "finalize", scope));
  }
}

function basenameOf(path: LocalPath): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

async function listTemporary(root: LocalPath, limit: number): Promise<readonly BlobLocation[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const locations: BlobLocation[] = [];
  for (const entry of entries) {
    if (locations.length >= limit) {
      break;
    }
    if (!entry.isFile() || !isTemporaryArtifactName(entry.name)) {
      continue;
    }
    const parsed = artifactId.parse(
      entry.name.slice(
        TEMPORARY_ARTIFACT_PREFIX.length,
        entry.name.length - TEMPORARY_ARTIFACT_SUFFIX.length,
      ),
    );
    if (parsed.ok) {
      locations.push({ scope: "temporary", artifactId: parsed.value });
    }
  }
  return locations;
}

async function listDigests(
  scope: "content" | "quarantine",
  limit: number,
  shards: (scope: "content" | "quarantine") => Promise<readonly LocalPath[]>,
): Promise<readonly BlobLocation[]> {
  const locations: BlobLocation[] = [];
  for (const shard of await shards(scope)) {
    if (locations.length >= limit) {
      break;
    }
    const entries = await readdir(shard, { withFileTypes: true });
    for (const entry of entries) {
      if (locations.length >= limit) {
        break;
      }
      if (!entry.isFile()) {
        continue;
      }
      const parsed = contentDigest.parse(`${DIGEST_PREFIX}${entry.name}`);
      if (parsed.ok) {
        locations.push({ scope, digest: parsed.value });
      }
    }
  }
  return locations;
}
