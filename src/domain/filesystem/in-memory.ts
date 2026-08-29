/** In-memory FileSystemPort used by domain and application tests. */

import { err, ok, type Result } from "../result.ts";
import {
  type FileKind,
  type FileSystemError,
  type FileSystemOperation,
  type FileSystemPort,
  type LocalPath,
  localPath,
  type PathEntry,
  parentPath,
  parseLocalPath,
} from "./contracts.ts";

/** How an in-memory node is described to the test double. */
export type InMemoryNode = {
  readonly kind: FileKind;
  /** File content. `byteLength` is derived from it when both are absent. */
  readonly text?: string;
  /** Binary file content. `byteLength` is derived from it when present. */
  readonly bytes?: Uint8Array;
  readonly byteLength?: number;
  readonly mode?: number;
  /** For a symlink: the absolute path it points at. */
  readonly target?: string;
  /** Test-only revision override for stale-read scenarios. */
  readonly revision?: string;
  /** Paths whose writes this double refuses, for permission tests. */
  readonly writable?: boolean;
};

export type InMemoryFileSystemOptions = {
  readonly nodes?: Readonly<Record<string, InMemoryNode>>;
  /** Default permission bits reported for a node that declares none. */
  readonly defaultMode?: number;
};

/**
 * An in-memory `FileSystemPort` for tests.
 *
 * Real enough to exercise the decisions that matter — missing paths, wrong
 * kinds, unwritable directories, and symlinks pointing out of a root — without
 * a temporary directory. The adapter's own tests use a real one.
 */
export function createInMemoryFileSystem(
  options: InMemoryFileSystemOptions = {},
): FileSystemPort & {
  /** Every path the double still holds, sorted. Used to assert what survived. */
  paths(): readonly LocalPath[];
  /** Adds or replaces a node after construction. */
  put(path: string, node: InMemoryNode): void;
} {
  const defaultMode = options.defaultMode ?? 0o700;
  const nodes = new Map<string, InMemoryNode>();
  let writeGeneration = 0;
  for (const [path, node] of Object.entries(options.nodes ?? {})) {
    nodes.set(localPath(path), node);
  }

  const entryFor = (path: LocalPath): PathEntry | null => {
    const node = nodes.get(path);
    if (node === undefined) {
      return null;
    }
    return {
      path,
      kind: node.kind,
      byteLength: node.kind === "file" ? byteLengthOf(node) : 0,
      mode: node.mode ?? defaultMode,
      revision: node.revision ?? `${node.kind}:${byteLengthOf(node)}`,
    };
  };

  const byteLengthOf = (node: InMemoryNode): number =>
    node.byteLength ??
    (node.bytes === undefined
      ? node.text === undefined
        ? 0
        : Buffer.byteLength(node.text, "utf8")
      : node.bytes.byteLength);

  const cancelled = (
    path: LocalPath,
    operation: FileSystemOperation,
  ): Result<never, FileSystemError> =>
    err({ kind: "filesystem", code: "cancelled", path, operation });

  const parentIsWritable = (path: LocalPath): boolean => {
    const parent = path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";
    return nodes.get(parent)?.writable !== false;
  };

  return {
    paths: (): readonly LocalPath[] => [...nodes.keys()].sort() as LocalPath[],

    put(path: string, node: InMemoryNode): void {
      nodes.set(localPath(path), node);
    },

    async stat(path, signal) {
      return signal?.aborted === true ? cancelled(path, "stat") : ok(entryFor(path));
    },

    async createDirectory(path, mode, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "create-directory");
      }
      const existing = nodes.get(path);
      if (existing !== undefined) {
        return existing.kind === "directory"
          ? ok("existed")
          : err({
              kind: "filesystem",
              code: "not-a-directory",
              path,
              operation: "create-directory",
            });
      }
      if (!parentIsWritable(path)) {
        return err({
          kind: "filesystem",
          code: "permission-denied",
          path,
          operation: "create-directory",
        });
      }
      nodes.set(path, { kind: "directory", mode });
      return ok("created");
    },

    async list(path, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "list");
      }
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "list" });
      }
      if (node.kind !== "directory") {
        return err({ kind: "filesystem", code: "not-a-directory", path, operation: "list" });
      }
      const prefix = `${path === "/" ? "" : path}/`;
      const children: PathEntry[] = [];
      for (const candidate of nodes.keys()) {
        if (!candidate.startsWith(prefix)) {
          continue;
        }
        const rest = candidate.slice(prefix.length);
        if (rest.length === 0 || rest.includes("/")) {
          continue;
        }
        const entry = entryFor(candidate as LocalPath);
        if (entry !== null) {
          children.push(entry);
        }
      }
      return ok(children.sort((left, right) => left.path.localeCompare(right.path)));
    },

    async removeEntry(path, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "remove");
      }
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "remove" });
      }
      if (!parentIsWritable(path)) {
        return err({ kind: "filesystem", code: "permission-denied", path, operation: "remove" });
      }
      if (node.kind === "directory") {
        const prefix = `${path}/`;
        for (const candidate of nodes.keys()) {
          if (candidate.startsWith(prefix)) {
            return err({ kind: "filesystem", code: "not-empty", path, operation: "remove" });
          }
        }
      }
      nodes.delete(path);
      return ok(null);
    },

    async removeEmptyDirectory(path, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "remove");
      }
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "remove" });
      }
      if (node.kind !== "directory") {
        return err({ kind: "filesystem", code: "not-a-directory", path, operation: "remove" });
      }
      const prefix = `${path}/`;
      for (const candidate of nodes.keys()) {
        if (candidate.startsWith(prefix)) {
          return err({ kind: "filesystem", code: "not-empty", path, operation: "remove" });
        }
      }
      nodes.delete(path);
      return ok(null);
    },

    async realPath(path, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "real-path");
      }
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "real-path" });
      }
      if (node.kind === "symlink" && node.target !== undefined) {
        return parseLocalPath(node.target).ok
          ? ok(localPath(node.target))
          : err({ kind: "filesystem", code: "io-failure", path, operation: "real-path" });
      }
      return ok(path);
    },

    async probeWritable(path, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "probe-writable");
      }
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "probe-writable" });
      }
      return ok(node.writable !== false);
    },

    async readText(path, maximumBytes, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "read-text");
      }
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "read-text" });
      }
      if (node.kind !== "file") {
        return err({ kind: "filesystem", code: "not-a-directory", path, operation: "read-text" });
      }
      if (byteLengthOf(node) > maximumBytes) {
        return err({ kind: "filesystem", code: "oversized", path, operation: "read-text" });
      }
      return ok(node.text ?? "");
    },

    async readBytes(path, maximumBytes, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "read-bytes");
      }
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "read-bytes" });
      }
      if (node.kind !== "file") {
        return err({ kind: "filesystem", code: "not-a-directory", path, operation: "read-bytes" });
      }
      if (byteLengthOf(node) > maximumBytes) {
        return err({ kind: "filesystem", code: "oversized", path, operation: "read-bytes" });
      }
      return ok(
        node.bytes === undefined
          ? Uint8Array.from(Buffer.from(node.text ?? "", "utf8"))
          : new Uint8Array(node.bytes),
      );
    },

    async readBytesRange(path, offset, maximumBytes, signal) {
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
      const node = nodes.get(path);
      if (node === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "read-bytes-range" });
      }
      if (node.kind !== "file") {
        return err({
          kind: "filesystem",
          code: "not-a-directory",
          path,
          operation: "read-bytes-range",
        });
      }
      const bytes =
        node.bytes === undefined
          ? Uint8Array.from(Buffer.from(node.text ?? "", "utf8"))
          : new Uint8Array(node.bytes);
      if (offset > bytes.byteLength) {
        return err({
          kind: "filesystem",
          code: "range-out-of-bounds",
          path,
          operation: "read-bytes-range",
        });
      }
      return ok(bytes.slice(offset, offset + maximumBytes));
    },

    async writeBytes(path, bytes, signal) {
      if (signal?.aborted === true) {
        return cancelled(path, "write");
      }
      const existing = nodes.get(path);
      if (existing !== undefined && existing.kind !== "file") {
        return err({
          kind: "filesystem",
          code: "not-a-directory",
          path,
          operation: "write",
        });
      }
      const parent = parentPath(path);
      if (parent === null) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "write" });
      }
      const parentNode = nodes.get(parent);
      if (parentNode === undefined) {
        return err({ kind: "filesystem", code: "not-found", path, operation: "write" });
      }
      if (parentNode.kind !== "directory") {
        return err({
          kind: "filesystem",
          code: "not-a-directory",
          path,
          operation: "write",
        });
      }
      if (!parentIsWritable(path)) {
        return err({
          kind: "filesystem",
          code: "permission-denied",
          path,
          operation: "write",
        });
      }
      const copy = new Uint8Array(bytes);
      let text: string | undefined;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(copy);
      } catch {
        text = undefined;
      }
      writeGeneration += 1;
      const revision = `write:${writeGeneration}:${copy.byteLength}`;
      nodes.set(path, {
        kind: "file",
        bytes: copy,
        ...(text === undefined ? {} : { text }),
        ...(existing?.mode === undefined ? {} : { mode: existing.mode }),
        revision,
      });
      return ok({ byteLength: copy.byteLength, revision });
    },

    async renameEntry(from, to, signal) {
      if (signal?.aborted === true) {
        return cancelled(from, "rename");
      }
      const source = nodes.get(from);
      if (source === undefined) {
        return err({ kind: "filesystem", code: "not-found", path: from, operation: "rename" });
      }
      if (nodes.get(to) !== undefined) {
        return err({ kind: "filesystem", code: "not-empty", path: to, operation: "rename" });
      }
      const parent = parentPath(to);
      if (parent === null || nodes.get(parent)?.kind !== "directory") {
        return err({ kind: "filesystem", code: "not-found", path: to, operation: "rename" });
      }
      if (!parentIsWritable(to)) {
        return err({
          kind: "filesystem",
          code: "permission-denied",
          path: to,
          operation: "rename",
        });
      }
      if (to === from || to.startsWith(`${from}/`)) {
        return err({ kind: "filesystem", code: "io-failure", path: to, operation: "rename" });
      }
      const moving: Array<readonly [string, InMemoryNode]> = [];
      for (const [path, node] of nodes) {
        if (path === from || path.startsWith(`${from}/`)) {
          moving.push([path, node]);
        }
      }
      for (const [path, node] of moving) {
        nodes.set(`${to}${path.slice(from.length)}`, node);
      }
      for (const [path] of moving) {
        nodes.delete(path);
      }
      return ok(null);
    },

    async copyEntry(from, to, signal) {
      if (signal?.aborted === true) {
        return cancelled(from, "copy");
      }
      const source = nodes.get(from);
      if (source === undefined) {
        return err({ kind: "filesystem", code: "not-found", path: from, operation: "copy" });
      }
      if (source.kind === "directory") {
        return err({
          kind: "filesystem",
          code: "not-a-directory",
          path: from,
          operation: "copy",
        });
      }
      if (nodes.get(to) !== undefined) {
        return err({ kind: "filesystem", code: "not-empty", path: to, operation: "copy" });
      }
      const parent = parentPath(to);
      if (parent === null || nodes.get(parent)?.kind !== "directory") {
        return err({ kind: "filesystem", code: "not-found", path: to, operation: "copy" });
      }
      if (!parentIsWritable(to)) {
        return err({
          kind: "filesystem",
          code: "permission-denied",
          path: to,
          operation: "copy",
        });
      }
      nodes.set(to, {
        kind: source.kind,
        ...(source.text === undefined ? {} : { text: source.text }),
        ...(source.bytes === undefined ? {} : { bytes: new Uint8Array(source.bytes) }),
        ...(source.mode === undefined ? {} : { mode: source.mode }),
        ...(source.target === undefined ? {} : { target: source.target }),
        revision: source.kind === "file" ? `copy:${byteLengthOf(source)}` : `copy-link`,
      });
      return ok(null);
    },
  };
}
