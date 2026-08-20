/**
 * Application-backed workspace-set mutations for the interactive shell (#607).
 *
 * Collects path/name text from the UI and hands it to the same resolve/layout
 * stores the CLI uses. The overlay never calls `realPath` or writes layout
 * files itself.
 */

import {
  createWorkspaceLayoutStore,
  resolveWorkspaceSet,
  type WorkspaceLayoutStore,
} from "../../application/index.ts";
import {
  createWorkspaceSet,
  type FileSystemPort,
  type LocalPath,
  parseLocalPath,
  resolveLocalPath,
  type WorkspaceSet,
  workspaceRootId,
} from "../../domain/index.ts";
import type { WorkspaceRootView, WorkspaceSetView } from "./format.ts";

export type WorkspaceControllerError =
  | { readonly code: "cancelled" }
  | { readonly code: "empty" }
  | { readonly code: "invalid-path"; readonly detail: string }
  | { readonly code: "set"; readonly detail: string }
  | { readonly code: "layout"; readonly detail: string }
  | { readonly code: "not-found" }
  | { readonly code: "exists" }
  | { readonly code: "primary-required" };

export type WorkspaceLayoutListEntry = {
  readonly name: string;
  readonly rootCount: number;
};

export type WorkspaceController = {
  readonly initial: WorkspaceSetView;
  addRoot(
    set: WorkspaceSetView,
    pathText: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceSetView }
    | { readonly ok: false; readonly error: WorkspaceControllerError }
  >;
  removeRoot(
    set: WorkspaceSetView,
    rootId: string,
  ):
    | { readonly ok: true; readonly value: WorkspaceSetView }
    | { readonly ok: false; readonly error: WorkspaceControllerError };
  save(
    set: WorkspaceSetView,
    name: string,
    options?: { readonly force?: boolean; readonly signal?: AbortSignal },
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceSetView }
    | { readonly ok: false; readonly error: WorkspaceControllerError }
  >;
  load(
    name: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceSetView }
    | { readonly ok: false; readonly error: WorkspaceControllerError }
  >;
  listLayouts(
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: readonly WorkspaceLayoutListEntry[] }
    | { readonly ok: false; readonly error: WorkspaceControllerError }
  >;
};

function viewFromSet(set: WorkspaceSet): WorkspaceSetView {
  return {
    roots: set.roots.map((root) => ({
      rootId: String(root.rootId),
      name: root.name,
      path: String(root.path),
    })),
  };
}

function setFromView(
  view: WorkspaceSetView,
):
  | { readonly ok: true; readonly value: WorkspaceSet }
  | { readonly ok: false; readonly error: WorkspaceControllerError } {
  const built = createWorkspaceSet(
    view.roots.map((root) => ({
      rootId: workspaceRootId.from(root.rootId),
      name: root.name,
      path: root.path as LocalPath,
    })),
  );
  if (!built.ok) {
    return { ok: false, error: { code: "set", detail: built.error.code } };
  }
  return built;
}

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

export function describeWorkspaceControllerError(error: WorkspaceControllerError): string {
  switch (error.code) {
    case "cancelled":
      return "Workspace work was cancelled.";
    case "empty":
      return "The workspace set is empty.";
    case "invalid-path":
      return `That path could not be used (${error.detail}).`;
    case "set":
      return `Workspace set refused (${error.detail}).`;
    case "layout":
      return `Saved layout refused (${error.detail}).`;
    case "not-found":
      return "No saved layout matches that name.";
    case "exists":
      return "A layout with that name already exists; save again with force.";
    case "primary-required":
      return "The primary root cannot be removed.";
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

export function createWorkspaceController(options: {
  readonly fileSystem: FileSystemPort;
  readonly configurationRoot: LocalPath;
  readonly currentDirectory: LocalPath | null;
  readonly initial: WorkspaceSet;
}): WorkspaceController {
  const store: WorkspaceLayoutStore = createWorkspaceLayoutStore(
    options.fileSystem,
    options.configurationRoot,
  );
  const initial = viewFromSet(options.initial);

  return {
    initial,
    async addRoot(set, pathText, signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const trimmed = pathText.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: { code: "invalid-path", detail: "empty" } };
      }
      const candidate =
        options.currentDirectory === null
          ? parseLocalPath(trimmed)
          : resolveLocalPath(options.currentDirectory, trimmed);
      if (!candidate.ok) {
        return { ok: false, error: { code: "invalid-path", detail: "unparseable" } };
      }
      const usedNames = new Set(set.roots.map((root) => root.name));
      const usedIds = new Set(set.roots.map((root) => root.rootId));
      let nextId = set.roots.length + 1;
      let rootId = `root-${nextId}`;
      while (usedIds.has(rootId)) {
        nextId += 1;
        rootId = `root-${nextId}`;
      }
      const entries = [
        ...set.roots.map((root) => ({
          rootId: root.rootId,
          name: root.name,
          path: root.path,
        })),
        {
          rootId,
          name: uniqueName(basenameLabel(candidate.value), usedNames),
          path: candidate.value as string,
        },
      ];
      const resolved = await resolveWorkspaceSet(options.fileSystem, entries, signal);
      if (!resolved.ok) {
        if (resolved.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        return {
          ok: false,
          error: {
            code: "set",
            detail: "code" in resolved.error ? resolved.error.code : "resolve",
          },
        };
      }
      return { ok: true, value: viewFromSet(resolved.value) };
    },

    removeRoot(set, rootId) {
      if (set.roots[0]?.rootId === rootId) {
        return { ok: false, error: { code: "primary-required" } };
      }
      const remaining = set.roots.filter((root) => root.rootId !== rootId);
      if (remaining.length === set.roots.length) {
        return { ok: false, error: { code: "not-found" } };
      }
      const rebuilt = setFromView({ roots: remaining });
      if (!rebuilt.ok) {
        return rebuilt;
      }
      return { ok: true, value: viewFromSet(rebuilt.value) };
    },

    async save(set, name, saveOptions = {}) {
      const rebuilt = setFromView(set);
      if (!rebuilt.ok) {
        return rebuilt;
      }
      const saved = await store.save(name, rebuilt.value, {
        force: saveOptions.force === true,
        ...(saveOptions.signal === undefined ? {} : { signal: saveOptions.signal }),
      });
      if (!saved.ok) {
        if (saved.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        if (saved.error.code === "exists") {
          return { ok: false, error: { code: "exists" } };
        }
        if (saved.error.code === "not-found") {
          return { ok: false, error: { code: "not-found" } };
        }
        return { ok: false, error: { code: "layout", detail: saved.error.code } };
      }
      return { ok: true, value: set };
    },

    async load(name, signal) {
      const loaded = await store.load(name, signal);
      if (!loaded.ok) {
        if (loaded.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        if (loaded.error.code === "not-found") {
          return { ok: false, error: { code: "not-found" } };
        }
        if (loaded.error.code === "unusable-roots") {
          return { ok: false, error: { code: "layout", detail: "unusable-roots" } };
        }
        return { ok: false, error: { code: "layout", detail: loaded.error.code } };
      }
      return { ok: true, value: viewFromSet(loaded.value.set) };
    },

    async listLayouts(signal) {
      const listed = await store.list({
        ...(signal === undefined ? {} : { signal }),
      });
      if (!listed.ok) {
        if (listed.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        return { ok: false, error: { code: "layout", detail: listed.error.code } };
      }
      return {
        ok: true,
        value: listed.value.layouts.map((entry) => ({
          name: String(entry.name),
          rootCount: entry.rootCount,
        })),
      };
    },
  };
}

export function rootsEqual(
  left: readonly WorkspaceRootView[],
  right: readonly WorkspaceRootView[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (root, index) =>
      root.rootId === right[index]?.rootId &&
      root.name === right[index]?.name &&
      root.path === right[index]?.path,
  );
}
