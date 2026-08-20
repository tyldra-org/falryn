/**
 * Workspace-set resolve and path bind with symlink-escape detection (#604).
 *
 * Domain identity is lexical. This seam resolves each root through
 * {@link FileSystemPort.realPath}, refuses non-directories, then reuses the
 * single-root binder so symlink escape stays against the chosen root only.
 */

import {
  type BindWorkspaceSetPathOptions,
  type BoundWorkspaceSetPath,
  bindWorkspaceSetPath,
  createWorkspaceSet,
  type FileSystemError,
  type FileSystemPort,
  type LocalPath,
  parseLocalPath,
  type WorkspaceSet,
  type WorkspaceSetBindError,
  type WorkspaceSetError,
} from "../domain/index.ts";
import { createWorkspacePathBinder } from "./workspace-path.ts";

export type WorkspaceSetResolveError =
  | WorkspaceSetError
  | { readonly code: "cancelled" }
  | { readonly code: "not-directory" }
  | { readonly code: "missing" }
  | { readonly code: "filesystem"; readonly error: FileSystemError };

export type WorkspaceSetProbeError =
  | WorkspaceSetBindError
  | { readonly code: "symlink-escape" }
  | { readonly code: "cancelled" }
  | { readonly code: "filesystem"; readonly error: FileSystemError };

export type WorkspaceSetRootInput = {
  readonly rootId: unknown;
  readonly name: unknown;
  readonly path: unknown;
};

export type WorkspaceSetBinder = {
  bind(
    set: WorkspaceSet,
    value: unknown,
    options?: BindWorkspaceSetPathOptions & { readonly signal?: AbortSignal },
  ): Promise<
    | { readonly ok: true; readonly value: BoundWorkspaceSetPath }
    | { readonly ok: false; readonly error: WorkspaceSetProbeError }
  >;
};

/**
 * Resolves candidate roots to canonical directories, then builds a workspace set.
 *
 * Paths must already be absolute before `realPath`. Overlap and duplicate
 * refusal stay in {@link createWorkspaceSet}.
 */
export async function resolveWorkspaceSet(
  fileSystem: FileSystemPort,
  entries: readonly WorkspaceSetRootInput[],
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: WorkspaceSet }
  | { readonly ok: false; readonly error: WorkspaceSetResolveError }
> {
  if (signal?.aborted === true) {
    return { ok: false, error: { code: "cancelled" } };
  }
  if (entries.length === 0) {
    return { ok: false, error: { code: "empty" } };
  }

  const resolved: {
    readonly rootId: unknown;
    readonly name: unknown;
    readonly path: LocalPath;
  }[] = [];

  for (const entry of entries) {
    const parsed = parseLocalPath(entry.path);
    if (!parsed.ok) {
      return { ok: false, error: { code: "not-absolute", reason: parsed.error.code } };
    }
    const real = await fileSystem.realPath(parsed.value, signal);
    if (!real.ok) {
      if (real.error.code === "cancelled") {
        return { ok: false, error: { code: "cancelled" } };
      }
      if (real.error.code === "not-found") {
        return { ok: false, error: { code: "missing" } };
      }
      return { ok: false, error: { code: "filesystem", error: real.error } };
    }
    const statted = await fileSystem.stat(real.value, signal);
    if (!statted.ok) {
      if (statted.error.code === "cancelled") {
        return { ok: false, error: { code: "cancelled" } };
      }
      return { ok: false, error: { code: "filesystem", error: statted.error } };
    }
    if (statted.value === null) {
      return { ok: false, error: { code: "missing" } };
    }
    if (statted.value.kind !== "directory") {
      return { ok: false, error: { code: "not-directory" } };
    }
    resolved.push({ rootId: entry.rootId, name: entry.name, path: real.value });
  }

  return createWorkspaceSet(resolved);
}

export function createWorkspaceSetBinder(fileSystem: FileSystemPort): WorkspaceSetBinder {
  const pathBinder = createWorkspacePathBinder(fileSystem);
  return {
    async bind(set, value, options = {}) {
      const bindOptions = options.rootId === undefined ? {} : { rootId: options.rootId };
      const lexical = bindWorkspaceSetPath(set, value, bindOptions);
      if (!lexical.ok) {
        return lexical;
      }
      const probed = await pathBinder.bind(lexical.value.root, value, options.signal);
      if (!probed.ok) {
        return probed;
      }
      return {
        ok: true,
        value: {
          ...probed.value,
          rootId: lexical.value.rootId,
        },
      };
    },
  };
}
