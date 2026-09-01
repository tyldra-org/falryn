/**
 * The filesystem port, and the path type it speaks in.
 *
 * The port is deliberately shallow: it stats, creates one directory, lists one
 * directory, removes one entry, resolves one link, writes one file, renames one
 * entry, and copies one non-directory. Recursion is not here.
 *
 * That is the whole point. Every dangerous decision in local-data removal —
 * whether to descend, whether an entry escaped its root through a link, whether
 * to stop — is a decision that has to be unit-testable without a real disk. A
 * port with `removeRecursive` would move all of it into the adapter, where the
 * only way to test it is to actually delete things.
 *
 * Paths are absolute and forward-slashed, including on Windows, where the
 * platform APIs accept that form. One separator in the domain beats two.
 */

import type { Brand } from "../identity.ts";
import { err, ok, type Result } from "../result.ts";

/** An absolute, normalized filesystem path. */
export type LocalPath = Brand<string, "LocalPath">;

/** Longest path this build accepts, in UTF-16 code units. */
export const MAX_LOCAL_PATH_LENGTH = 1_024;

export type LocalPathErrorCode =
  | "path-not-a-string"
  | "path-empty"
  | "path-too-long"
  | "path-not-absolute"
  | "path-illegal-character"
  | "path-escapes-root";

export type LocalPathError = {
  readonly kind: "local-path";
  readonly code: LocalPathErrorCode;
};

function pathError(code: LocalPathErrorCode): LocalPathError {
  return { kind: "local-path", code };
}

/** `/usr/local` or `C:/Users/x`. A drive letter is the only accepted prefix. */
const WINDOWS_ROOT = /^[A-Za-z]:\//;

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || WINDOWS_ROOT.test(value);
}

/**
 * Collapses separators and resolves `.` and `..` textually.
 *
 * Textual resolution is correct here because it runs *before* anything touches
 * the disk: it is how `..` is refused, not how a link is followed. Link
 * behavior is a separate question the port answers with `realPath`.
 */
function normalize(value: string): string {
  const forward = value.replace(/\\/g, "/");
  const windowsPrefix = WINDOWS_ROOT.exec(forward)?.[0] ?? null;
  const body = windowsPrefix === null ? forward.slice(1) : forward.slice(windowsPrefix.length);

  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join("/");
  return windowsPrefix === null ? `/${joined}` : `${windowsPrefix}${joined}`;
}

/**
 * Why a path's text could never name a location, or `null` when it could.
 *
 * Separate from `parseLocalPath` because these rules hold whether or not the
 * text is absolute: a caller that is about to resolve a relative path still has
 * to refuse a NUL before it builds one. Never echoes the rejected text.
 */
export function localPathTextError(value: unknown): LocalPathError | null {
  if (typeof value !== "string") {
    return pathError("path-not-a-string");
  }
  if (value.length === 0) {
    return pathError("path-empty");
  }
  if (value.length > MAX_LOCAL_PATH_LENGTH) {
    return pathError("path-too-long");
  }
  // A NUL truncates the path at every syscall boundary underneath us.
  if (value.includes("\0")) {
    return pathError("path-illegal-character");
  }
  return null;
}

/** Validates an untrusted path. Never echoes the rejected text. */
export function parseLocalPath(value: unknown): Result<LocalPath, LocalPathError> {
  const text = localPathTextError(value);
  if (text !== null) {
    return err(text);
  }
  const candidate = value as string;
  if (!isAbsolute(candidate.replace(/\\/g, "/"))) {
    return err(pathError("path-not-absolute"));
  }
  return ok(normalize(candidate) as LocalPath);
}

/**
 * Resolves a possibly-relative path against an absolute base.
 *
 * `parseLocalPath` refuses anything relative, which is right for a stored or
 * declared path: those name a location on their own. A path a person typed does
 * not. `--workspace ./site` means the directory beside them, and treating it as
 * unnameable would discard the layer they were pointing at. Resolution is
 * textual and runs before anything touches the disk, exactly as normalization
 * does; `..` is collapsed here rather than refused, because climbing out of the
 * current directory is what `../sibling` was asked to do.
 */
export function resolveLocalPath(
  base: LocalPath,
  value: unknown,
): Result<LocalPath, LocalPathError> {
  const text = localPathTextError(value);
  if (text !== null) {
    return err(text);
  }
  const candidate = value as string;
  // Length is re-checked by `parseLocalPath` against the joined text, so a
  // short relative path under a long base is still refused.
  return parseLocalPath(
    isAbsolute(candidate.replace(/\\/g, "/")) ? candidate : `${base}/${candidate}`,
  );
}

/**
 * Validates a trusted path and throws on rejection.
 *
 * Use only where an invalid path is a defect, such as a platform-map literal.
 */
export function localPath(value: string): LocalPath {
  const parsed = parseLocalPath(value);
  if (!parsed.ok) {
    throw new Error(`invalid local path: ${parsed.error.code}`);
  }
  return parsed.value;
}

/**
 * Appends relative segments to a base path.
 *
 * A segment that is absolute, contains a separator, or is `..` is refused
 * rather than normalized away: joining is how a caller names a child, and a
 * child that climbs out of its parent is a caller error, not a path to fix up.
 */
export function joinPath(
  base: LocalPath,
  ...segments: readonly string[]
): Result<LocalPath, LocalPathError> {
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return err(pathError("path-escapes-root"));
    }
    if (segment.includes("/") || segment.includes("\\")) {
      return err(pathError("path-escapes-root"));
    }
    if (segment.includes("\0")) {
      return err(pathError("path-illegal-character"));
    }
  }
  return parseLocalPath(`${base}/${segments.join("/")}`);
}

/** The last segment of a path, or `""` at a filesystem root. */
export function baseName(path: LocalPath): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(index + 1);
}

/**
 * The directory containing this path, or `null` at the filesystem root.
 *
 * Textual, like every other path rule here, and it runs before anything touches
 * a disk. `null` rather than `/` for the root itself, so a caller walking
 * upwards terminates instead of circling on a path that is its own parent.
 */
export function parentPath(path: LocalPath): LocalPath | null {
  const index = path.lastIndexOf("/");
  if (index < 0 || path === "/") {
    return null;
  }
  return (index === 0 ? "/" : path.slice(0, index)) as LocalPath;
}

/**
 * Whether `candidate` is `root` or lies beneath it.
 *
 * Compares whole segments, so `/data/falryn-old` is not inside `/data/falryn`.
 */
export function isInside(root: LocalPath, candidate: LocalPath): boolean {
  if (candidate === root) {
    return true;
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

export type FileKind = "directory" | "file" | "symlink" | "other";

export type PathEntry = {
  readonly path: LocalPath;
  readonly kind: FileKind;
  /** Bytes for a file; `0` for anything else. */
  readonly byteLength: number;
  /** POSIX permission bits, or `null` where the platform reports none. */
  readonly mode: number | null;
  /**
   * Adapter-owned revision captured with the stat.
   *
   * It is opaque to the domain and is compared before and after a read. A
   * caller must not infer time, inode, or platform semantics from its value.
   */
  readonly revision: string;
};

export type FileSystemErrorCode =
  | "not-found"
  | "not-a-directory"
  | "permission-denied"
  | "not-empty"
  | "range-out-of-bounds"
  | "oversized"
  | "malformed-encoding"
  | "io-failure"
  | "unsupported"
  | "cross-device"
  | "cancelled";

export type FileSystemOperation =
  | "stat"
  | "create-directory"
  | "list"
  | "remove"
  | "real-path"
  | "probe-writable"
  | "read-text"
  | "read-bytes"
  | "read-bytes-range"
  | "write"
  | "rename"
  | "copy";

/**
 * A filesystem failure.
 *
 * Carries the path, the operation, and a code. It never carries file content,
 * and never the underlying platform message, which routinely embeds an absolute
 * path plus an errno string that means nothing to a user.
 */
export type FileSystemError = {
  readonly kind: "filesystem";
  readonly code: FileSystemErrorCode;
  readonly path: LocalPath;
  readonly operation: FileSystemOperation;
};

export type CreateDirectoryOutcome = "created" | "existed";

export type FileWriteReceipt = {
  readonly byteLength: number;
  readonly revision: string;
};

export type FileSystemPort = {
  /** Describes one path without following a final symlink. `null` when missing. */
  stat(path: LocalPath, signal?: AbortSignal): Promise<Result<PathEntry | null, FileSystemError>>;

  /**
   * Creates one directory, and every missing parent, with `mode`.
   *
   * Reports whether it created the directory or found one, because "already
   * existed" is a fact a first-run report has to be able to state.
   */
  createDirectory(
    path: LocalPath,
    mode: number,
    signal?: AbortSignal,
  ): Promise<Result<CreateDirectoryOutcome, FileSystemError>>;

  /** Lists one directory, without descending. */
  list(
    path: LocalPath,
    signal?: AbortSignal,
  ): Promise<Result<readonly PathEntry[], FileSystemError>>;

  /** Removes one file, one symlink, or one empty directory. Never recursive. */
  removeEntry(path: LocalPath, signal?: AbortSignal): Promise<Result<null, FileSystemError>>;

  /**
   * Removes one empty directory without accepting any other entry kind.
   *
   * Callers use this when replacing an observed empty directory. The adapter
   * must fail if the path is now a file, symlink, or populated directory so a
   * concurrent change cannot turn a safe cleanup into data loss.
   */
  removeEmptyDirectory(
    path: LocalPath,
    signal?: AbortSignal,
  ): Promise<Result<null, FileSystemError>>;

  /** Resolves every symlink in the path, so an escape can be detected. */
  realPath(path: LocalPath, signal?: AbortSignal): Promise<Result<LocalPath, FileSystemError>>;

  /** Whether this process may write into an existing directory. */
  probeWritable(path: LocalPath, signal?: AbortSignal): Promise<Result<boolean, FileSystemError>>;

  /**
   * Reads one file as UTF-8 text, refusing anything past `maximumBytes`.
   *
   * The bound is checked against the file's size before the bytes are read, so
   * an oversized file costs a stat rather than its own length in memory. A
   * missing file reports `not-found` rather than resolving to empty text: an
   * absent configuration source and an empty one mean different things, and a
   * reader that conflated them would silently accept a truncated write.
   */
  readText(
    path: LocalPath,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Result<string, FileSystemError>>;

  /**
   * Reads one file as bytes, refusing anything past `maximumBytes`.
   *
   * The size check happens before the bytes are loaded so binary readers can
   * apply the same workspace memory boundary as text readers.
   */
  readBytes(
    path: LocalPath,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileSystemError>>;

  /**
   * Reads at most `maximumBytes` from a file offset.
   *
   * The adapter returns the bytes actually available at the tail. This is the
   * bounded primitive used to preserve a large source without loading it all
   * into the reader's inline result.
   */
  readBytesRange(
    path: LocalPath,
    offset: number,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, FileSystemError>>;

  /**
   * Replaces one file's bytes atomically when the adapter can.
   *
   * The write is to a sibling temporary name, then renamed onto `path`.
   * Cross-device and Windows replacement are not claimed as atomic. Directories
   * and final symlinks are refused. Missing parents are `not-found`.
   */
  writeBytes(
    path: LocalPath,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Result<FileWriteReceipt, FileSystemError>>;

  /**
   * Renames one entry onto an absent destination on the same filesystem.
   *
   * A directory moves with its children as one rename. `cross-device` means
   * the adapter could not rename across mount points; the caller may copy,
   * verify, then remove. The destination must be absent. Final-symlink
   * destinations are refused.
   */
  renameEntry(
    from: LocalPath,
    to: LocalPath,
    signal?: AbortSignal,
  ): Promise<Result<null, FileSystemError>>;

  /**
   * Copies one file or one symlink onto an absent destination.
   *
   * Directories are refused so recursion stays in the caller. A symlink is
   * copied as a link; its target is not followed.
   */
  copyEntry(
    from: LocalPath,
    to: LocalPath,
    signal?: AbortSignal,
  ): Promise<Result<null, FileSystemError>>;
};
