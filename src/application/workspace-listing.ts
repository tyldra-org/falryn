/**
 * Workspace stat, list, and bounded walk (#280).
 *
 * Binds the caller path, then uses {@link FileSystemPort} metadata only.
 * Descent never follows a symlink. File bytes stay #56.
 */

import {
  type BoundWorkspacePath,
  bindWorkspacePath,
  compareWorkspaceEntries,
  entryFromStat,
  type FileSystemPort,
  isHiddenLogical,
  isInside,
  type LocalPath,
  listingLimits,
  type WalkTruncation,
  type WorkspaceEntry,
  type WorkspaceEntryFailure,
  type WorkspaceListingError,
  type WorkspaceListingLimits,
  type WorkspaceListResult,
  type WorkspaceStatResult,
  type WorkspaceWalkResult,
} from "../domain/index.ts";

export type WorkspaceListing = {
  stat(
    root: LocalPath,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceStatResult }
    | { readonly ok: false; readonly error: WorkspaceListingError }
  >;
  list(
    root: LocalPath,
    value: unknown,
    limits?: Partial<WorkspaceListingLimits>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceListResult }
    | { readonly ok: false; readonly error: WorkspaceListingError }
  >;
  walk(
    root: LocalPath,
    value: unknown,
    limits?: Partial<WorkspaceListingLimits>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceWalkResult }
    | { readonly ok: false; readonly error: WorkspaceListingError }
  >;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function bindListingPath(
  fileSystem: FileSystemPort,
  root: LocalPath,
  value: unknown,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceListingError }
> {
  const lexical = bindWorkspacePath(root, value);
  if (!lexical.ok) {
    return lexical;
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const real = await fileSystem.realPath(lexical.value.resolved, signal);
  if (!real.ok) {
    if (real.error.code === "cancelled") {
      return { ok: false, error: { code: "cancelled" } };
    }
    if (real.error.code === "not-found") {
      return lexical;
    }
    return { ok: false, error: { code: "filesystem", reason: real.error.code } };
  }
  if (!isInside(root, real.value)) {
    return { ok: false, error: { code: "symlink-escape" } };
  }
  return lexical;
}

function toEntry(
  root: LocalPath,
  requested: string,
  stat: { path: LocalPath; kind: WorkspaceEntry["kind"]; byteLength: number; mode: number | null },
): WorkspaceEntry {
  const logical =
    stat.path === root ? "" : stat.path.slice(root.endsWith("/") ? root.length : root.length + 1);
  return {
    requested,
    logical,
    resolved: stat.path,
    kind: stat.kind,
    byteLength: stat.byteLength,
    mode: stat.mode,
  };
}

export function createWorkspaceListing(fileSystem: FileSystemPort): WorkspaceListing {
  return {
    async stat(root, value, signal) {
      const bound = await bindListingPath(fileSystem, root, value, signal);
      if (!bound.ok) {
        return bound;
      }
      if (isAborted(signal)) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const stated = await fileSystem.stat(bound.value.resolved, signal);
      if (!stated.ok) {
        return stated.error.code === "cancelled"
          ? { ok: false, error: { code: "cancelled" } }
          : { ok: false, error: { code: "filesystem", reason: stated.error.code } };
      }
      if (stated.value === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      return { ok: true, value: entryFromStat(bound.value, stated.value) };
    },

    async list(root, value, limits, signal) {
      const bound = await bindListingPath(fileSystem, root, value, signal);
      if (!bound.ok) {
        return bound;
      }
      const settings = listingLimits(limits);
      const stated = await fileSystem.stat(bound.value.resolved, signal);
      if (!stated.ok) {
        return stated.error.code === "cancelled"
          ? { ok: false, error: { code: "cancelled" } }
          : { ok: false, error: { code: "filesystem", reason: stated.error.code } };
      }
      if (stated.value === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      if (stated.value.kind !== "directory") {
        return { ok: false, error: { code: "not-a-directory" } };
      }
      const listed = await fileSystem.list(bound.value.resolved, signal);
      if (!listed.ok) {
        return listed.error.code === "cancelled"
          ? { ok: false, error: { code: "cancelled" } }
          : { ok: false, error: { code: "filesystem", reason: listed.error.code } };
      }
      const entries: WorkspaceEntry[] = [];
      const failures: WorkspaceEntryFailure[] = [];
      for (const child of listed.value) {
        if (isAborted(signal)) {
          return { ok: false, error: { code: "cancelled" } };
        }
        if (!isInside(root, child.path)) {
          failures.push({
            logical: child.path,
            error: { code: "escaped" },
          });
          continue;
        }
        const entry = toEntry(root, child.path, child);
        if (!settings.includeHidden && isHiddenLogical(entry.logical)) {
          continue;
        }
        entries.push(entry);
      }
      entries.sort(compareWorkspaceEntries);
      const truncated = entries.length > settings.maxEntries;
      return {
        ok: true,
        value: {
          directory: bound.value,
          entries: truncated ? entries.slice(0, settings.maxEntries) : entries,
          failures,
          truncated,
        },
      };
    },

    async walk(root, value, limits, signal) {
      const bound = await bindListingPath(fileSystem, root, value, signal);
      if (!bound.ok) {
        return bound;
      }
      const settings = listingLimits(limits);
      const startStat = await fileSystem.stat(bound.value.resolved, signal);
      if (!startStat.ok) {
        return startStat.error.code === "cancelled"
          ? { ok: false, error: { code: "cancelled" } }
          : { ok: false, error: { code: "filesystem", reason: startStat.error.code } };
      }
      if (startStat.value === null) {
        return { ok: false, error: { code: "not-found" } };
      }

      const entries: WorkspaceEntry[] = [entryFromStat(bound.value, startStat.value)];
      const failures: WorkspaceEntryFailure[] = [];
      let truncation: WalkTruncation | null = null;
      const queue: { readonly path: LocalPath; readonly depth: number }[] = [];

      if (startStat.value.kind === "directory") {
        queue.push({ path: bound.value.resolved, depth: 0 });
      }

      while (queue.length > 0) {
        if (isAborted(signal)) {
          return { ok: false, error: { code: "cancelled" } };
        }
        const current = queue.shift();
        if (current === undefined) {
          break;
        }
        if (current.depth >= settings.maxDepth) {
          truncation = "depth-limit";
          continue;
        }
        const listed = await fileSystem.list(current.path, signal);
        if (!listed.ok) {
          if (listed.error.code === "cancelled") {
            return { ok: false, error: { code: "cancelled" } };
          }
          const logical =
            current.path === root
              ? ""
              : current.path.slice(root.endsWith("/") ? root.length : root.length + 1);
          failures.push({
            logical,
            error: { code: "filesystem", reason: listed.error.code },
          });
          continue;
        }
        const children = [...listed.value].sort((left, right) =>
          left.path.localeCompare(right.path),
        );
        for (const child of children) {
          if (isAborted(signal)) {
            return { ok: false, error: { code: "cancelled" } };
          }
          if (!isInside(root, child.path)) {
            failures.push({ logical: child.path, error: { code: "escaped" } });
            continue;
          }
          const entry = toEntry(root, child.path, child);
          if (!settings.includeHidden && isHiddenLogical(entry.logical)) {
            continue;
          }
          if (entries.length >= settings.maxEntries) {
            truncation = "entry-limit";
            break;
          }
          entries.push(entry);
          if (child.kind === "directory") {
            queue.push({ path: child.path, depth: current.depth + 1 });
          }
        }
        if (truncation === "entry-limit") {
          break;
        }
      }

      entries.sort(compareWorkspaceEntries);
      return {
        ok: true,
        value: {
          start: bound.value,
          entries,
          failures,
          truncated: truncation !== null,
          truncation,
        },
      };
    },
  };
}
