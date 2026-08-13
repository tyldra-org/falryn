/**
 * Workspace path bind with symlink-escape detection (#55).
 *
 * Domain bind is lexical. This seam asks {@link FileSystemPort.realPath} only
 * after a successful lexical bind so a link cannot sneak out of the root.
 */

import {
  type BoundWorkspacePath,
  bindWorkspacePath,
  type FileSystemError,
  type FileSystemPort,
  isInside,
  type LocalPath,
  type WorkspacePathBindError,
} from "../domain/index.ts";

export type WorkspacePathProbeError =
  | WorkspacePathBindError
  | { readonly code: "symlink-escape" }
  | { readonly code: "filesystem"; readonly error: FileSystemError };

export type WorkspacePathBinder = {
  bind(
    root: LocalPath,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: BoundWorkspacePath }
    | { readonly ok: false; readonly error: WorkspacePathProbeError }
  >;
};

export function createWorkspacePathBinder(fileSystem: FileSystemPort): WorkspacePathBinder {
  return {
    async bind(root, value, signal) {
      const lexical = bindWorkspacePath(root, value);
      if (!lexical.ok) {
        return lexical;
      }
      const real = await fileSystem.realPath(lexical.value.resolved, signal);
      if (!real.ok) {
        if (real.error.code === "not-found") {
          return lexical;
        }
        return { ok: false, error: { code: "filesystem", error: real.error } };
      }
      if (!isInside(root, real.value)) {
        return { ok: false, error: { code: "symlink-escape" } };
      }
      return {
        ok: true,
        value: {
          ...lexical.value,
          resolved: real.value,
          logical:
            real.value === root
              ? ""
              : real.value.slice(root.endsWith("/") ? root.length : root.length + 1),
        },
      };
    },
  };
}
