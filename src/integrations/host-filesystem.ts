/**
 * The host filesystem adapter.
 *
 * A leaf: it translates `node:fs` results and errno strings into Falryn's
 * `FileSystemPort` and nothing else. No recursion, no policy, no knowledge of
 * roots or ownership classes — those live in `src/data/` and must stay testable
 * without deleting anything.
 *
 * Two translation choices worth stating:
 *
 * - **`stat` does not follow a final symlink.** It uses `lstat`, so a link is
 *   reported as a link. A port that silently followed it would make "is this
 *   entry inside its root" unanswerable, which is the question every removal
 *   depends on.
 * - **An unrecognized errno becomes `io-failure`, never a message.** Platform
 *   error text embeds absolute paths and errno spellings that differ per OS;
 *   passing it through would put both into every diagnostic.
 */

import {
  closeSync,
  type Dirent,
  promises as fs,
  constants as fsConstants,
  fsyncSync,
  openSync,
  type Stats,
  writeSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open as openFile } from "node:fs/promises";

import {
  type CreateDirectoryOutcome,
  err,
  type FileKind,
  type FileSystemError,
  type FileSystemErrorCode,
  type FileSystemOperation,
  type FileSystemPort,
  type FileWriteReceipt,
  type FlushReport,
  joinPath,
  type LocalPath,
  MAX_STREAM_WRITE_BYTES,
  type OutputStreamPort,
  ok,
  type PathEntry,
  parentPath,
  parseLocalPath,
  type Result,
  type StreamWrite,
} from "../domain/index.ts";

/** errno spellings this adapter recognizes. Anything else is `io-failure`. */
const ERRNO_CODES: Readonly<Record<string, FileSystemErrorCode>> = {
  ENOENT: "not-found",
  ENOTDIR: "not-a-directory",
  EACCES: "permission-denied",
  EPERM: "permission-denied",
  EROFS: "permission-denied",
  ENOTEMPTY: "not-empty",
  EEXIST: "not-empty",
  EISDIR: "not-a-directory",
  ELOOP: "io-failure",
  ENAMETOOLONG: "io-failure",
  ENOSYS: "unsupported",
  EFBIG: "oversized",
  ENOSPC: "io-failure",
  EXDEV: "cross-device",
};

function errnoOf(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null) {
    return null;
  }
  const code = (thrown as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function translate(
  thrown: unknown,
  path: LocalPath,
  operation: FileSystemOperation,
): FileSystemError {
  const errno = errnoOf(thrown);
  const code = errno === null ? "io-failure" : (ERRNO_CODES[errno] ?? "io-failure");
  return { kind: "filesystem", code, path, operation };
}

function kindOf(stats: Stats | Dirent): FileKind {
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}

/** POSIX permission bits, or `null` where the platform reports none. */
function modeOf(stats: Stats): number | null {
  return process.platform === "win32" ? null : stats.mode & 0o777;
}

/** A comparable, adapter-owned identity for one stat snapshot. */
function revisionOf(stats: Stats): string {
  return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function cancelled(
  path: LocalPath,
  operation: FileSystemOperation,
): Result<never, FileSystemError> {
  return err({ kind: "filesystem", code: "cancelled", path, operation });
}

function isCancelled(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export function createHostFileSystem(): FileSystemPort {
  return {
    async stat(
      path: LocalPath,
      signal?: AbortSignal,
    ): Promise<Result<PathEntry | null, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "stat");
      }
      try {
        const stats = await fs.lstat(path);
        return ok({
          path,
          kind: kindOf(stats),
          byteLength: stats.isFile() ? stats.size : 0,
          mode: modeOf(stats),
          revision: revisionOf(stats),
        });
      } catch (thrown: unknown) {
        // Missing is an answer, not a failure: every caller here asks "is this
        // there" before deciding what to do, and a throw would make the common
        // case the exceptional one.
        if (errnoOf(thrown) === "ENOENT") {
          return ok(null);
        }
        return err(translate(thrown, path, "stat"));
      }
    },

    async createDirectory(
      path: LocalPath,
      mode: number,
      signal?: AbortSignal,
    ): Promise<Result<CreateDirectoryOutcome, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "create-directory");
      }
      try {
        const created = await fs.mkdir(path, { recursive: true, mode });
        if (created === undefined) {
          return ok("existed");
        }
        // `recursive` applies the mode only to directories it creates, and a
        // umask can still narrow it. Setting it explicitly is what makes the
        // private-mode guarantee true rather than probable.
        await fs.chmod(path, mode);
        return ok("created");
      } catch (thrown: unknown) {
        return err(translate(thrown, path, "create-directory"));
      }
    },

    async list(
      path: LocalPath,
      signal?: AbortSignal,
    ): Promise<Result<readonly PathEntry[], FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "list");
      }
      try {
        const dirents = await fs.readdir(path, { withFileTypes: true });
        const entries: PathEntry[] = [];
        for (const dirent of dirents) {
          const child = joinPath(path, dirent.name);
          if (!child.ok) {
            continue;
          }
          const kind = kindOf(dirent);
          let byteLength = 0;
          let mode: number | null = null;
          let revision = `${kind}:unknown`;
          try {
            const stats = await fs.lstat(child.value);
            byteLength = stats.isFile() ? stats.size : 0;
            mode = modeOf(stats);
            revision = revisionOf(stats);
          } catch {
            // Vanished between readdir and lstat. It is still an entry that
            // was there; reporting it with zero bytes beats dropping it.
          }
          entries.push({ path: child.value, kind, byteLength, mode, revision });
        }
        return ok(entries);
      } catch (thrown: unknown) {
        return err(translate(thrown, path, "list"));
      }
    },

    async removeEntry(
      path: LocalPath,
      signal?: AbortSignal,
    ): Promise<Result<null, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "remove");
      }
      try {
        const stats = await fs.lstat(path);
        // `rmdir` on a directory and `unlink` on everything else, including a
        // symlink to a directory. Neither is recursive, so this adapter can
        // never delete more than the one entry it was named.
        if (stats.isDirectory()) {
          await fs.rmdir(path);
        } else {
          await fs.unlink(path);
        }
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, path, "remove"));
      }
    },

    async realPath(
      path: LocalPath,
      signal?: AbortSignal,
    ): Promise<Result<LocalPath, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "real-path");
      }
      try {
        const resolved = await fs.realpath(path);
        const parsed = parseLocalPath(resolved);
        return parsed.ok ? ok(parsed.value) : err(translate(null, path, "real-path"));
      } catch (thrown: unknown) {
        return err(translate(thrown, path, "real-path"));
      }
    },

    async probeWritable(
      path: LocalPath,
      signal?: AbortSignal,
    ): Promise<Result<boolean, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "probe-writable");
      }
      try {
        await fs.access(path, fsConstants.W_OK | fsConstants.X_OK);
        return ok(true);
      } catch (thrown: unknown) {
        const errno = errnoOf(thrown);
        if (errno === "EACCES" || errno === "EPERM" || errno === "EROFS") {
          return ok(false);
        }
        return err(translate(thrown, path, "probe-writable"));
      }
    },

    async readText(
      path: LocalPath,
      maximumBytes: number,
      signal?: AbortSignal,
    ): Promise<Result<string, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "read-text");
      }
      try {
        // Sized first. Reading then measuring would already have spent the
        // memory the bound exists to refuse.
        const stats = await fs.stat(path);
        if (!stats.isFile()) {
          return err({ kind: "filesystem", code: "not-a-directory", path, operation: "read-text" });
        }
        if (stats.size > maximumBytes) {
          return err({ kind: "filesystem", code: "oversized", path, operation: "read-text" });
        }
        const bytes = await fs.readFile(path);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return ok(text);
      } catch (thrown: unknown) {
        // A decoder failure is a TypeError with no errno, which would otherwise
        // land on the generic io-failure and lose why the file was refused.
        if (thrown instanceof TypeError) {
          return err({
            kind: "filesystem",
            code: "malformed-encoding",
            path,
            operation: "read-text",
          });
        }
        return err(translate(thrown, path, "read-text"));
      }
    },

    async readBytes(
      path: LocalPath,
      maximumBytes: number,
      signal?: AbortSignal,
    ): Promise<Result<Uint8Array, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "read-bytes");
      }
      try {
        const stats = await fs.stat(path);
        if (!stats.isFile()) {
          return err({
            kind: "filesystem",
            code: "not-a-directory",
            path,
            operation: "read-bytes",
          });
        }
        if (stats.size > maximumBytes) {
          return err({ kind: "filesystem", code: "oversized", path, operation: "read-bytes" });
        }
        const bytes = await fs.readFile(path);
        return ok(new Uint8Array(bytes));
      } catch (thrown: unknown) {
        return err(translate(thrown, path, "read-bytes"));
      }
    },

    async readBytesRange(
      path: LocalPath,
      offset: number,
      maximumBytes: number,
      signal?: AbortSignal,
    ): Promise<Result<Uint8Array, FileSystemError>> {
      if (signal?.aborted === true) {
        return cancelled(path, "read-bytes-range");
      }
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 0
      ) {
        return err({
          kind: "filesystem",
          code: "range-out-of-bounds",
          path,
          operation: "read-bytes-range",
        });
      }
      let handle: FileHandle | null = null;
      try {
        const stats = await fs.stat(path);
        if (!stats.isFile()) {
          return err({
            kind: "filesystem",
            code: "not-a-directory",
            path,
            operation: "read-bytes-range",
          });
        }
        if (offset > stats.size) {
          return err({
            kind: "filesystem",
            code: "range-out-of-bounds",
            path,
            operation: "read-bytes-range",
          });
        }
        handle = await openFile(path, fsConstants.O_RDONLY);
        const buffer = new Uint8Array(maximumBytes);
        const result = await handle.read(buffer, 0, maximumBytes, offset);
        return ok(buffer.subarray(0, result.bytesRead));
      } catch (thrown: unknown) {
        return err(translate(thrown, path, "read-bytes-range"));
      } finally {
        await handle?.close();
      }
    },

    async writeBytes(
      path: LocalPath,
      bytes: Uint8Array,
      signal?: AbortSignal,
    ): Promise<Result<FileWriteReceipt, FileSystemError>> {
      if (isCancelled(signal)) {
        return cancelled(path, "write");
      }
      const parent = parentPath(path);
      if (parent === null) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "write" });
      }
      const payload = new Uint8Array(bytes);
      let tempPath: LocalPath | null = null;
      let handle: FileHandle | null = null;
      try {
        const existing = await fs.lstat(path).catch((thrown: unknown) => {
          if (errnoOf(thrown) === "ENOENT") {
            return null;
          }
          throw thrown;
        });
        if (existing !== null && !existing.isFile()) {
          return err({
            kind: "filesystem",
            code: "not-a-directory",
            path,
            operation: "write",
          });
        }
        const parentStats = await fs.lstat(parent);
        if (!parentStats.isDirectory()) {
          return err({
            kind: "filesystem",
            code: "not-a-directory",
            path,
            operation: "write",
          });
        }
        if (isCancelled(signal)) {
          return cancelled(path, "write");
        }
        const opened = await openTemporaryWrite(parent);
        tempPath = opened.path;
        handle = opened.handle;
        await handle.write(payload);
        await handle.sync();
        await handle.close();
        handle = null;
        if (process.platform !== "win32") {
          await fs.chmod(tempPath, existing === null ? 0o644 : existing.mode & 0o777);
        }
        if (isCancelled(signal)) {
          await fs.unlink(tempPath).catch(() => undefined);
          tempPath = null;
          return cancelled(path, "write");
        }
        await replaceWithRename(tempPath, path);
        tempPath = null;
        const written = await fs.lstat(path);
        return ok({
          byteLength: payload.byteLength,
          revision: revisionOf(written),
        });
      } catch (thrown: unknown) {
        return err(translate(thrown, path, "write"));
      } finally {
        await handle?.close().catch(() => undefined);
        if (tempPath !== null) {
          await fs.unlink(tempPath).catch(() => undefined);
        }
      }
    },

    async renameEntry(
      from: LocalPath,
      to: LocalPath,
      signal?: AbortSignal,
    ): Promise<Result<null, FileSystemError>> {
      if (isCancelled(signal)) {
        return cancelled(from, "rename");
      }
      try {
        const destination = await fs.lstat(to).catch((thrown: unknown) => {
          if (errnoOf(thrown) === "ENOENT") {
            return null;
          }
          throw thrown;
        });
        if (destination !== null) {
          return err({
            kind: "filesystem",
            code: "not-empty",
            path: to,
            operation: "rename",
          });
        }
        await fs.rename(from, to);
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, from, "rename"));
      }
    },

    async copyEntry(
      from: LocalPath,
      to: LocalPath,
      signal?: AbortSignal,
    ): Promise<Result<null, FileSystemError>> {
      if (isCancelled(signal)) {
        return cancelled(from, "copy");
      }
      try {
        const source = await fs.lstat(from);
        if (source.isDirectory()) {
          return err({
            kind: "filesystem",
            code: "not-a-directory",
            path: from,
            operation: "copy",
          });
        }
        const destination = await fs.lstat(to).catch((thrown: unknown) => {
          if (errnoOf(thrown) === "ENOENT") {
            return null;
          }
          throw thrown;
        });
        if (destination !== null) {
          return err({
            kind: "filesystem",
            code: "not-empty",
            path: to,
            operation: "copy",
          });
        }
        if (source.isSymbolicLink()) {
          const target = await fs.readlink(from);
          await fs.symlink(target, to);
          return ok(null);
        }
        if (!source.isFile()) {
          return err({
            kind: "filesystem",
            code: "unsupported",
            path: from,
            operation: "copy",
          });
        }
        await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
        if (process.platform !== "win32") {
          await fs.chmod(to, source.mode & 0o777);
        }
        return ok(null);
      } catch (thrown: unknown) {
        return err(translate(thrown, from, "copy"));
      }
    },
  };
}

/**
 * An `OutputStreamPort` that delivers bytes to one file on the host.
 *
 * Used when artifact retrieval names a destination rather than stdout. Lives here
 * rather than in the CLI so byte delivery stays in an adapter module.
 */
export function createHostFileOutputStream(path: LocalPath): OutputStreamPort {
  let handle: number | null = null;
  let closedCode: string | null = null;
  let pending = 0;

  const openHandle = (): number => {
    if (handle !== null) {
      return handle;
    }
    try {
      handle = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
        0o644,
      );
      return handle;
    } catch (thrown: unknown) {
      closedCode = errnoOf(thrown) ?? "unknown";
      throw thrown;
    }
  };

  return {
    write(bytes: Uint8Array): StreamWrite {
      if (bytes.byteLength > MAX_STREAM_WRITE_BYTES) {
        return { status: "too-large", accepted: 0, pending };
      }
      if (closedCode !== null) {
        return { status: "closed", accepted: 0, pending };
      }
      try {
        const written = writeSync(openHandle(), bytes);
        pending += written;
        return { status: "accepted", accepted: written, pending };
      } catch (thrown: unknown) {
        closedCode = errnoOf(thrown) ?? "unknown";
        return { status: "closed", accepted: 0, pending };
      }
    },

    async flush(): Promise<FlushReport> {
      if (closedCode !== null) {
        const unflushed = pending;
        pending = 0;
        return { status: "closed", flushed: 0, pending: unflushed, detail: closedCode };
      }
      if (handle !== null) {
        try {
          fsyncSync(handle);
        } catch (thrown: unknown) {
          closedCode = errnoOf(thrown) ?? "unknown";
          const unflushed = pending;
          pending = 0;
          return { status: "closed", flushed: 0, pending: unflushed, detail: closedCode };
        }
      }
      const flushed = pending;
      pending = 0;
      return { status: "flushed", flushed, pending: 0, detail: null };
    },

    isClosed(): boolean {
      return closedCode !== null;
    },

    dispose(): void {
      if (handle !== null) {
        try {
          closeSync(handle);
        } catch {
          // The handle is gone either way; a close failure is not recoverable here.
        }
        handle = null;
      }
    },
  };
}

async function openTemporaryWrite(
  directory: LocalPath,
): Promise<{ readonly path: LocalPath; readonly handle: FileHandle }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = `.falryn-write-${process.pid}-${Date.now()}-${attempt}.tmp`;
    const joined = joinPath(directory, name);
    if (!joined.ok) {
      continue;
    }
    try {
      const handle = await openFile(
        joined.value,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o644,
      );
      return { path: joined.value, handle };
    } catch (thrown: unknown) {
      if (errnoOf(thrown) === "EEXIST") {
        continue;
      }
      throw thrown;
    }
  }
  throw Object.assign(new Error("temporary write name exhausted"), { code: "EEXIST" });
}

async function replaceWithRename(from: LocalPath, to: LocalPath): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (thrown: unknown) {
    const code = errnoOf(thrown);
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
      throw thrown;
    }
    await fs.unlink(to);
    await fs.rename(from, to);
  }
}
