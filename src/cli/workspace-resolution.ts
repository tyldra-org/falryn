/**
 * Resolve `--workspace` / `--add-dir` into a workspace set for one CLI run (#606).
 *
 * A `--workspace` value that names an existing directory is a path. Otherwise a
 * legal layout name loads `layouts/<name>.jsonc`. `--add-dir` appends extra
 * roots for this invocation only.
 */

import { createWorkspaceLayoutStore } from "../application/index.ts";
import {
  createWorkspaceSet,
  err,
  type FileSystemPort,
  isLegalWorkspaceLayoutName,
  type LocalPath,
  ok,
  parseLocalPath,
  type Result,
  resolveLocalPath,
  type WorkspaceSet,
  workspaceRootId,
} from "../domain/index.ts";

export type WorkspaceResolveError =
  | { readonly code: "cancelled" }
  | { readonly code: "empty-workspace" }
  | { readonly code: "not-a-directory"; readonly path: string }
  | { readonly code: "missing-path"; readonly path: string }
  | { readonly code: "unknown-layout"; readonly name: string }
  | { readonly code: "layout"; readonly detail: string }
  | { readonly code: "add-dir"; readonly path: string; readonly detail: string }
  | { readonly code: "set"; readonly detail: string };

export type ResolvedCliWorkspace = {
  readonly set: WorkspaceSet;
  readonly primary: LocalPath;
  /** How the primary was chosen. */
  readonly source: "cwd" | "path" | "layout";
  readonly layoutName: string | null;
};

export type ResolveCliWorkspaceInput = {
  readonly fileSystem: FileSystemPort;
  readonly configurationRoot: LocalPath;
  readonly currentDirectory: LocalPath | null;
  /** Raw `--workspace` text, or null for the current directory. */
  readonly workspace: string | null;
  readonly addDirs: readonly string[];
  readonly signal?: AbortSignal;
};

function basenameLabel(path: LocalPath): string {
  const text = path as string;
  const segments = text.split("/").filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? "root";
  const cleaned = last.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (cleaned.length === 0) {
    return "root";
  }
  return /^[a-zA-Z0-9]/.test(cleaned) ? cleaned : `r-${cleaned}`;
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = base.slice(0, 64);
  let suffix = 2;
  while (used.has(candidate)) {
    const tag = `-${suffix}`;
    candidate = `${base.slice(0, Math.max(1, 64 - tag.length))}${tag}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

async function directoryAt(
  fileSystem: FileSystemPort,
  path: LocalPath,
  signal?: AbortSignal,
): Promise<Result<LocalPath, WorkspaceResolveError>> {
  const real = await fileSystem.realPath(path, signal);
  if (!real.ok) {
    if (real.error.code === "cancelled") {
      return err({ code: "cancelled" });
    }
    if (real.error.code === "not-found") {
      return err({ code: "missing-path", path: path as string });
    }
    return err({ code: "missing-path", path: path as string });
  }
  const statted = await fileSystem.stat(real.value, signal);
  if (!statted.ok) {
    if (statted.error.code === "cancelled") {
      return err({ code: "cancelled" });
    }
    return err({ code: "missing-path", path: path as string });
  }
  if (statted.value === null) {
    return err({ code: "missing-path", path: path as string });
  }
  if (statted.value.kind !== "directory") {
    return err({ code: "not-a-directory", path: path as string });
  }
  return ok(real.value);
}

function resolveCandidate(
  currentDirectory: LocalPath | null,
  value: string,
): Result<LocalPath, WorkspaceResolveError> {
  if (currentDirectory === null) {
    const parsed = parseLocalPath(value);
    return parsed.ok ? parsed : err({ code: "missing-path", path: value });
  }
  const resolved = resolveLocalPath(currentDirectory, value);
  return resolved.ok ? resolved : err({ code: "missing-path", path: value });
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Builds the invocation workspace set from globals.
 *
 * Path wins when the resolved location is a directory. Otherwise a legal layout
 * name is loaded. Relative layout-looking tokens that contain path separators
 * never become layout names.
 */
export async function resolveCliWorkspace(
  input: ResolveCliWorkspaceInput,
): Promise<Result<ResolvedCliWorkspace, WorkspaceResolveError>> {
  if (isCancelled(input.signal)) {
    return err({ code: "cancelled" });
  }

  let primaryEntries: {
    readonly rootId: string;
    readonly name: string;
    readonly path: LocalPath;
  }[] = [];
  let source: ResolvedCliWorkspace["source"] = "cwd";
  let layoutName: string | null = null;

  if (input.workspace === null) {
    if (input.currentDirectory === null) {
      return err({ code: "empty-workspace" });
    }
    const directory = await directoryAt(input.fileSystem, input.currentDirectory, input.signal);
    if (!directory.ok) {
      return directory;
    }
    primaryEntries = [
      {
        rootId: "root-1",
        name: uniqueName(basenameLabel(directory.value), new Set()),
        path: directory.value,
      },
    ];
    source = "cwd";
  } else {
    const asPath = resolveCandidate(input.currentDirectory, input.workspace);
    let usedAsDirectory = false;
    if (asPath.ok) {
      const directory = await directoryAt(input.fileSystem, asPath.value, input.signal);
      if (directory.ok) {
        primaryEntries = [
          {
            rootId: "root-1",
            name: uniqueName(basenameLabel(directory.value), new Set()),
            path: directory.value,
          },
        ];
        source = "path";
        usedAsDirectory = true;
      } else if (directory.error.code === "cancelled") {
        return directory;
      }
    }
    if (!usedAsDirectory) {
      if (!isLegalWorkspaceLayoutName(input.workspace)) {
        return err({
          code: "missing-path",
          path: input.workspace,
        });
      }
      const store = createWorkspaceLayoutStore(input.fileSystem, input.configurationRoot);
      const loaded = await store.load(input.workspace, input.signal);
      if (!loaded.ok) {
        if (loaded.error.code === "cancelled") {
          return err({ code: "cancelled" });
        }
        if (loaded.error.code === "not-found") {
          return err({ code: "unknown-layout", name: input.workspace });
        }
        if (loaded.error.code === "unusable-roots") {
          const first = loaded.error.unusable[0];
          return err({
            code: "layout",
            detail: first === undefined ? "unusable-roots" : `${first.reason}:${first.path}`,
          });
        }
        return err({ code: "layout", detail: loaded.error.code });
      }
      primaryEntries = loaded.value.set.roots.map((root) => ({
        rootId: root.rootId as string,
        name: root.name,
        path: root.path,
      }));
      source = "layout";
      layoutName = input.workspace;
    }
  }

  const usedNames = new Set(primaryEntries.map((entry) => entry.name));
  const usedIds = new Set(primaryEntries.map((entry) => entry.rootId));
  const roots = [...primaryEntries];
  let nextId = roots.length + 1;

  for (const addDir of input.addDirs) {
    if (isCancelled(input.signal)) {
      return err({ code: "cancelled" });
    }
    const candidate = resolveCandidate(input.currentDirectory, addDir);
    if (!candidate.ok) {
      return err({ code: "add-dir", path: addDir, detail: "missing-path" });
    }
    const directory = await directoryAt(input.fileSystem, candidate.value, input.signal);
    if (!directory.ok) {
      if (directory.error.code === "cancelled") {
        return directory;
      }
      return err({
        code: "add-dir",
        path: addDir,
        detail: directory.error.code,
      });
    }
    let rootId = `root-${nextId}`;
    while (usedIds.has(rootId)) {
      nextId += 1;
      rootId = `root-${nextId}`;
    }
    usedIds.add(rootId);
    nextId += 1;
    roots.push({
      rootId,
      name: uniqueName(basenameLabel(directory.value), usedNames),
      path: directory.value,
    });
  }

  const set = createWorkspaceSet(
    roots.map((root) => ({
      rootId: workspaceRootId.from(root.rootId),
      name: root.name,
      path: root.path,
    })),
  );
  if (!set.ok) {
    return err({ code: "set", detail: set.error.code });
  }
  const primary = set.value.roots[0]?.path;
  if (primary === undefined) {
    return err({ code: "empty-workspace" });
  }
  return ok({ set: set.value, primary, source, layoutName });
}

export function describeWorkspaceResolveError(error: WorkspaceResolveError): string {
  switch (error.code) {
    case "cancelled":
      return "Workspace resolution was cancelled.";
    case "empty-workspace":
      return "No workspace root could be resolved.";
    case "not-a-directory":
      return "Argument workspace: the path is not a directory.";
    case "missing-path":
      return "Argument workspace: the path could not be resolved as a directory or saved layout.";
    case "unknown-layout":
      return "Argument workspace: no saved layout matches that name.";
    case "layout":
      return `Argument workspace: saved layout could not be loaded (${error.detail}).`;
    case "add-dir":
      return `Argument add-dir: ${error.detail}.`;
    case "set":
      return `Workspace set refused (${error.detail}).`;
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
