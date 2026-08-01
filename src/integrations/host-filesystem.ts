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

import { type Dirent, promises as fs, constants as fsConstants, type Stats } from "node:fs";

import {
  type CreateDirectoryOutcome,
  err,
  type FileKind,
  type FileSystemError,
  type FileSystemErrorCode,
  type FileSystemOperation,
  type FileSystemPort,
  joinPath,
  type LocalPath,
  ok,
  type PathEntry,
  parseLocalPath,
  type Result,
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

function cancelled(
  path: LocalPath,
  operation: FileSystemOperation,
): Result<never, FileSystemError> {
  return err({ kind: "filesystem", code: "cancelled", path, operation });
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
          if (kind === "file" || kind === "directory") {
            try {
              const stats = await fs.lstat(child.value);
              byteLength = stats.isFile() ? stats.size : 0;
              mode = modeOf(stats);
            } catch {
              // Vanished between readdir and lstat. It is still an entry that
              // was there; reporting it with zero bytes beats dropping it.
            }
          }
          entries.push({ path: child.value, kind, byteLength, mode });
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
  };
}
