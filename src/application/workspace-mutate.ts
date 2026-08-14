/**
 * Workspace move, copy, trash, and remove (#282).
 *
 * Binds source and destination, previews affected paths, then renames on the
 * same filesystem or copies, verifies, and removes across devices. Recursion
 * uses {@link FileSystemPort.list}; the port never removes or copies a tree.
 * Patch hunks, rollback, and product tools remain later work.
 */

import {
  type BoundWorkspacePath,
  baseName,
  bindWorkspacePath,
  computeMutationPlanId,
  destinationInsideSource,
  type FileKind,
  type FileSystemError,
  type FileSystemPort,
  isInside,
  joinPath,
  type LocalPath,
  type MutationAffectedEntry,
  type MutationTransport,
  type ParsedWorkspaceMutation,
  parentPath,
  parseLocalPath,
  parseWorkspaceMutation,
  type WorkspaceMutationError,
  type WorkspaceMutationItem,
  type WorkspaceMutationPreview,
  type WorkspaceMutationResult,
} from "../domain/index.ts";
import { createWorkspaceListing } from "./workspace-listing.ts";

export type WorkspaceMutator = {
  preview(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceMutationPreview }
    | { readonly ok: false; readonly error: WorkspaceMutationError }
  >;
  apply(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceMutationResult }
    | { readonly ok: false; readonly error: WorkspaceMutationError }
  >;
};

export type WorkspaceMutatorOptions = {
  readonly fileSystem: FileSystemPort;
};

type SourceTree = {
  readonly bound: BoundWorkspacePath;
  readonly kind: FileKind;
  readonly revision: string;
  readonly entries: readonly {
    readonly logical: string;
    readonly resolved: LocalPath;
    readonly kind: FileKind;
  }[];
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function fromFilesystem(error: FileSystemError): WorkspaceMutationError {
  switch (error.code) {
    case "cancelled":
      return { code: "cancelled" };
    case "not-found":
      return { code: "not-found" };
    case "not-empty":
      return { code: "not-empty" };
    case "not-a-directory":
      return { code: "not-a-directory" };
    default:
      return { code: "filesystem", reason: error.code };
  }
}

async function bindExisting(
  fileSystem: FileSystemPort,
  root: LocalPath,
  value: string,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceMutationError }
> {
  const lexical = bindWorkspacePath(root, value);
  if (!lexical.ok) {
    return lexical;
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const stated = await fileSystem.stat(lexical.value.resolved, signal);
  if (!stated.ok) {
    return { ok: false, error: fromFilesystem(stated.error) };
  }
  if (stated.value === null) {
    return { ok: false, error: { code: "not-found" } };
  }
  if (stated.value.kind === "symlink") {
    return lexical;
  }
  const real = await fileSystem.realPath(lexical.value.resolved, signal);
  if (!real.ok) {
    return { ok: false, error: fromFilesystem(real.error) };
  }
  if (!isInside(root, real.value)) {
    return { ok: false, error: { code: "symlink-escape" } };
  }
  return lexical;
}

async function bindDestination(
  fileSystem: FileSystemPort,
  root: LocalPath,
  value: string,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceMutationError }
> {
  const lexical = bindWorkspacePath(root, value);
  if (!lexical.ok) {
    return lexical;
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const real = await fileSystem.realPath(lexical.value.resolved, signal);
  if (real.ok) {
    if (!isInside(root, real.value)) {
      return { ok: false, error: { code: "symlink-escape" } };
    }
    return lexical;
  }
  if (real.error.code === "cancelled") {
    return { ok: false, error: { code: "cancelled" } };
  }
  if (real.error.code !== "not-found") {
    return { ok: false, error: { code: "filesystem", reason: real.error.code } };
  }
  let cursor = parentPath(lexical.value.resolved);
  while (cursor !== null) {
    if (isAborted(signal)) {
      return { ok: false, error: { code: "cancelled" } };
    }
    const parentReal = await fileSystem.realPath(cursor, signal);
    if (parentReal.ok) {
      if (!isInside(root, parentReal.value)) {
        return { ok: false, error: { code: "symlink-escape" } };
      }
      return lexical;
    }
    if (parentReal.error.code === "cancelled") {
      return { ok: false, error: { code: "cancelled" } };
    }
    if (parentReal.error.code === "not-found") {
      cursor = parentPath(cursor);
      continue;
    }
    return { ok: false, error: { code: "filesystem", reason: parentReal.error.code } };
  }
  return { ok: false, error: { code: "not-found" } };
}

function mappedPath(sourceRoot: LocalPath, destRoot: LocalPath, child: LocalPath): LocalPath {
  if (child === sourceRoot) {
    return destRoot;
  }
  const parsed = parseLocalPath(`${destRoot}${child.slice(sourceRoot.length)}`);
  return parsed.ok ? parsed.value : destRoot;
}

async function loadSourceTree(
  fileSystem: FileSystemPort,
  root: LocalPath,
  parsed: ParsedWorkspaceMutation,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: SourceTree }
  | { readonly ok: false; readonly error: WorkspaceMutationError }
> {
  const bound = await bindExisting(fileSystem, root, parsed.source, signal);
  if (!bound.ok) {
    return bound;
  }
  const stated = await fileSystem.stat(bound.value.resolved, signal);
  if (!stated.ok) {
    return { ok: false, error: fromFilesystem(stated.error) };
  }
  if (stated.value === null) {
    return { ok: false, error: { code: "not-found" } };
  }
  if (stated.value.kind !== "directory") {
    return {
      ok: true,
      value: {
        bound: bound.value,
        kind: stated.value.kind,
        revision: stated.value.revision,
        entries: [
          {
            logical: bound.value.logical,
            resolved: bound.value.resolved,
            kind: stated.value.kind,
          },
        ],
      },
    };
  }
  const walked = await createWorkspaceListing(fileSystem).walk(
    root,
    parsed.source,
    parsed.limits,
    signal,
  );
  if (!walked.ok) {
    return walked;
  }
  if (walked.value.truncated) {
    return {
      ok: false,
      error: { code: "too-broad", truncation: walked.value.truncation ?? "entry-limit" },
    };
  }
  if (walked.value.failures.length > 0) {
    return { ok: false, error: { code: "plan-refused" } };
  }
  const childCount = walked.value.entries.filter(
    (entry) => entry.resolved !== bound.value.resolved,
  ).length;
  if (childCount > 0 && !parsed.recursive) {
    return { ok: false, error: { code: "not-empty" } };
  }
  return {
    ok: true,
    value: {
      bound: bound.value,
      kind: stated.value.kind,
      revision: stated.value.revision,
      entries: walked.value.entries.map((entry) => ({
        logical: entry.logical,
        resolved: entry.resolved,
        kind: entry.kind,
      })),
    },
  };
}

async function prepareDestination(
  fileSystem: FileSystemPort,
  root: LocalPath,
  parsed: ParsedWorkspaceMutation,
  source: SourceTree,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceMutationError }
> {
  if (parsed.destination === null) {
    return { ok: false, error: { code: "malformed-destination" } };
  }
  const bound = await bindDestination(fileSystem, root, parsed.destination, signal);
  if (!bound.ok) {
    return bound;
  }
  if (destinationInsideSource(source.bound.resolved, bound.value.resolved)) {
    return { ok: false, error: { code: "into-self" } };
  }
  const stated = await fileSystem.stat(bound.value.resolved, signal);
  if (!stated.ok) {
    return { ok: false, error: fromFilesystem(stated.error) };
  }
  if (stated.value === null) {
    return { ok: true, value: bound.value };
  }
  const sameEntry = stated.value.revision === source.revision && stated.value.kind === source.kind;
  if (sameEntry && parsed.operation === "move") {
    return { ok: true, value: bound.value };
  }
  if (parsed.overwrite === "error") {
    return { ok: false, error: { code: "already-exists" } };
  }
  if (parsed.overwrite === "merge") {
    return stated.value.kind === "directory" && source.kind === "directory"
      ? { ok: true, value: bound.value }
      : { ok: false, error: { code: "not-a-directory" } };
  }
  if (stated.value.kind === "directory") {
    return { ok: false, error: { code: "not-empty" } };
  }
  return { ok: true, value: bound.value };
}

async function trashDestination(
  fileSystem: FileSystemPort,
  root: LocalPath,
  parsed: ParsedWorkspaceMutation,
  source: SourceTree,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceMutationError }
> {
  if (parsed.destination === null) {
    return { ok: false, error: { code: "unsupported-trash" } };
  }
  const leaf = `${parsed.destination.replace(/\/+$/, "")}/${baseName(source.bound.resolved)}`;
  return prepareDestination(
    fileSystem,
    root,
    { ...parsed, destination: leaf, operation: "move" },
    source,
    signal,
  );
}

function previewFrom(
  parsed: ParsedWorkspaceMutation,
  source: SourceTree,
  destination: BoundWorkspacePath | null,
): WorkspaceMutationPreview {
  const entries: MutationAffectedEntry[] = source.entries.map((entry) => ({
    logical: entry.logical,
    resolved: entry.resolved,
    kind: entry.kind,
    role: "source" as const,
  }));
  if (destination !== null) {
    entries.push({
      logical: destination.logical,
      resolved: destination.resolved,
      kind: source.kind,
      role: "destination",
    });
  }
  return {
    operation: parsed.operation,
    planId: computeMutationPlanId(
      parsed.operation,
      source.bound.logical,
      destination?.logical ?? null,
      parsed.overwrite,
      parsed.recursive,
      source.entries.map((entry) => entry.logical),
    ),
    source: source.bound,
    destination,
    overwrite: parsed.overwrite,
    recursive: parsed.recursive,
    entries,
  };
}

async function ensureParent(
  fileSystem: FileSystemPort,
  path: LocalPath,
  signal?: AbortSignal,
): Promise<WorkspaceMutationError | null> {
  const parent = parentPath(path);
  if (parent === null) {
    return { code: "not-found" };
  }
  const created = await fileSystem.createDirectory(parent, 0o700, signal);
  return created.ok ? null : fromFilesystem(created.error);
}

async function removePrepared(
  fileSystem: FileSystemPort,
  dest: BoundWorkspacePath,
  overwrite: ParsedWorkspaceMutation["overwrite"],
  signal?: AbortSignal,
): Promise<WorkspaceMutationError | null> {
  const stated = await fileSystem.stat(dest.resolved, signal);
  if (!stated.ok) {
    return fromFilesystem(stated.error);
  }
  if (stated.value === null || overwrite !== "replace") {
    return null;
  }
  if (stated.value.kind === "directory") {
    return { code: "not-empty" };
  }
  const removed = await fileSystem.removeEntry(dest.resolved, signal);
  return removed.ok ? null : fromFilesystem(removed.error);
}

type Progress = {
  readonly error: WorkspaceMutationError | null;
  readonly completed: ReadonlySet<string>;
  readonly current: LocalPath | null;
};

function emptyProgress(error: WorkspaceMutationError): Progress {
  return { error, completed: new Set(), current: null };
}

async function copyTree(
  fileSystem: FileSystemPort,
  source: SourceTree,
  dest: LocalPath,
  merge: boolean,
  signal?: AbortSignal,
): Promise<Progress> {
  const destStat = await fileSystem.stat(dest, signal);
  if (!destStat.ok) {
    return emptyProgress(fromFilesystem(destStat.error));
  }
  const skipRoot = merge && destStat.value !== null;
  const ordered = [...source.entries].sort(
    (left, right) => left.resolved.length - right.resolved.length,
  );
  const completed = new Set<string>();
  for (const entry of ordered) {
    if (isAborted(signal)) {
      return { error: { code: "cancelled" }, completed, current: entry.resolved };
    }
    const target = mappedPath(source.bound.resolved, dest, entry.resolved);
    if (entry.kind === "directory") {
      if (entry.resolved === source.bound.resolved && skipRoot) {
        completed.add(entry.resolved);
        continue;
      }
      const created = await fileSystem.createDirectory(target, 0o700, signal);
      if (!created.ok) {
        return { error: fromFilesystem(created.error), completed, current: entry.resolved };
      }
      completed.add(entry.resolved);
      continue;
    }
    const copied = await fileSystem.copyEntry(entry.resolved, target, signal);
    if (!copied.ok) {
      return { error: fromFilesystem(copied.error), completed, current: entry.resolved };
    }
    completed.add(entry.resolved);
  }
  return { error: null, completed, current: null };
}

async function removeTree(
  fileSystem: FileSystemPort,
  source: SourceTree,
  signal?: AbortSignal,
): Promise<Progress> {
  const ordered = [...source.entries].sort(
    (left, right) => right.resolved.length - left.resolved.length,
  );
  const completed = new Set<string>();
  for (const entry of ordered) {
    if (isAborted(signal)) {
      return { error: { code: "cancelled" }, completed, current: entry.resolved };
    }
    const removed = await fileSystem.removeEntry(entry.resolved, signal);
    if (!removed.ok && removed.error.code !== "not-found") {
      return { error: fromFilesystem(removed.error), completed, current: entry.resolved };
    }
    completed.add(entry.resolved);
  }
  return { error: null, completed, current: null };
}

async function caseOnlyRename(
  fileSystem: FileSystemPort,
  source: LocalPath,
  dest: LocalPath,
  signal?: AbortSignal,
): Promise<WorkspaceMutationError | null> {
  const parent = parentPath(source);
  if (parent === null) {
    return { code: "not-found" };
  }
  const temp = joinPath(parent, `.falryn-rename-${process.pid}`);
  if (!temp.ok) {
    return { code: "filesystem", reason: "io-failure" };
  }
  const first = await fileSystem.renameEntry(source, temp.value, signal);
  if (!first.ok) {
    return fromFilesystem(first.error);
  }
  const second = await fileSystem.renameEntry(temp.value, dest, signal);
  if (!second.ok) {
    await fileSystem.renameEntry(temp.value, source, signal);
    return fromFilesystem(second.error);
  }
  return null;
}

function allApplied(source: SourceTree): Progress {
  return {
    error: null,
    completed: new Set(source.entries.map((entry) => entry.resolved)),
    current: null,
  };
}

function resultOf(
  preview: WorkspaceMutationPreview,
  transport: MutationTransport | null,
  progress: Progress,
): { readonly ok: true; readonly value: WorkspaceMutationResult } {
  const sources = preview.entries.filter((entry) => entry.role === "source");
  const items: WorkspaceMutationItem[] = sources.map((entry, index) => {
    if (progress.error === null || progress.completed.has(entry.resolved)) {
      return {
        index,
        status: "applied",
        logical: entry.logical,
        resolved: entry.resolved,
        error: null,
      };
    }
    if (entry.resolved === progress.current) {
      return {
        index,
        status: progress.error.code === "cancelled" ? "cancelled" : "failed",
        logical: entry.logical,
        resolved: entry.resolved,
        error: progress.error,
      };
    }
    return {
      index,
      status: "unscheduled",
      logical: entry.logical,
      resolved: entry.resolved,
      error: progress.error,
    };
  });
  return {
    ok: true,
    value: {
      operation: preview.operation,
      planId: preview.planId,
      transport,
      items,
    },
  };
}

export function createWorkspaceMutator(options: WorkspaceMutatorOptions): WorkspaceMutator {
  const { fileSystem } = options;

  async function buildPreview(
    root: LocalPath,
    parsed: ParsedWorkspaceMutation,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceMutationPreview }
    | { readonly ok: false; readonly error: WorkspaceMutationError }
  > {
    const source = await loadSourceTree(fileSystem, root, parsed, signal);
    if (!source.ok) {
      return source;
    }
    if (parsed.operation === "remove") {
      return { ok: true, value: previewFrom(parsed, source.value, null) };
    }
    const destination =
      parsed.operation === "trash"
        ? await trashDestination(fileSystem, root, parsed, source.value, signal)
        : await prepareDestination(fileSystem, root, parsed, source.value, signal);
    if (!destination.ok) {
      return destination;
    }
    return { ok: true, value: previewFrom(parsed, source.value, destination.value) };
  }

  return {
    async preview(root, request, signal) {
      const parsed = parseWorkspaceMutation(request);
      if (!parsed.ok) {
        return parsed;
      }
      return buildPreview(root, parsed.value, signal);
    },

    async apply(root, request, signal) {
      const parsed = parseWorkspaceMutation(request);
      if (!parsed.ok) {
        return parsed;
      }
      const previewed = await buildPreview(root, parsed.value, signal);
      if (!previewed.ok) {
        return previewed;
      }
      if (
        parsed.value.expectedPlanId !== null &&
        parsed.value.expectedPlanId !== previewed.value.planId
      ) {
        return { ok: false, error: { code: "stale-plan" } };
      }
      const source = await loadSourceTree(fileSystem, root, parsed.value, signal);
      if (!source.ok) {
        return source;
      }
      if (parsed.value.operation === "remove") {
        return resultOf(previewed.value, null, await removeTree(fileSystem, source.value, signal));
      }
      const dest = previewed.value.destination;
      if (dest === null) {
        return { ok: false, error: { code: "malformed-destination" } };
      }
      const parentError = await ensureParent(fileSystem, dest.resolved, signal);
      if (parentError !== null) {
        return { ok: false, error: parentError };
      }
      const cleared = await removePrepared(fileSystem, dest, parsed.value.overwrite, signal);
      if (cleared !== null) {
        return { ok: false, error: cleared };
      }
      if (dest.resolved === source.value.bound.resolved) {
        return resultOf(previewed.value, "rename", allApplied(source.value));
      }
      const destStat = await fileSystem.stat(dest.resolved, signal);
      if (!destStat.ok) {
        return { ok: false, error: fromFilesystem(destStat.error) };
      }
      const sameEntry =
        destStat.value !== null &&
        destStat.value.revision === source.value.revision &&
        destStat.value.kind === source.value.kind;
      if (parsed.value.operation !== "copy" && sameEntry) {
        const renamed = await caseOnlyRename(
          fileSystem,
          source.value.bound.resolved,
          dest.resolved,
          signal,
        );
        if (renamed !== null) {
          return { ok: false, error: renamed };
        }
        return resultOf(previewed.value, "rename", allApplied(source.value));
      }
      if (parsed.value.operation === "copy") {
        return resultOf(
          previewed.value,
          null,
          await copyTree(
            fileSystem,
            source.value,
            dest.resolved,
            parsed.value.overwrite === "merge",
            signal,
          ),
        );
      }
      const mergeExisting = parsed.value.overwrite === "merge" && destStat.value !== null;
      if (!mergeExisting) {
        const renamed = await fileSystem.renameEntry(
          source.value.bound.resolved,
          dest.resolved,
          signal,
        );
        if (renamed.ok) {
          return resultOf(previewed.value, "rename", allApplied(source.value));
        }
        if (renamed.error.code !== "cross-device") {
          return { ok: false, error: fromFilesystem(renamed.error) };
        }
      }
      const copied = await copyTree(fileSystem, source.value, dest.resolved, mergeExisting, signal);
      if (copied.error !== null) {
        return resultOf(previewed.value, "copy-verify-remove", copied);
      }
      const verified = await fileSystem.stat(dest.resolved, signal);
      if (!verified.ok) {
        return resultOf(previewed.value, "copy-verify-remove", {
          error: fromFilesystem(verified.error),
          completed: copied.completed,
          current: dest.resolved,
        });
      }
      if (verified.value === null) {
        return resultOf(previewed.value, "copy-verify-remove", {
          error: { code: "filesystem", reason: "io-failure" },
          completed: copied.completed,
          current: dest.resolved,
        });
      }
      return resultOf(
        previewed.value,
        "copy-verify-remove",
        await removeTree(fileSystem, source.value, signal),
      );
    },
  };
}
