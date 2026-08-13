/**
 * Bind tool paths to one workspace root (#55).
 *
 * Lexical only: separators, dots, `..`, NUL, length, and root membership.
 * Symlink escape is an application probe over {@link FileSystemPort.realPath}.
 * File bytes, listing, search, and patches remain later #54 children.
 */

import {
  isInside,
  type LocalPath,
  type LocalPathError,
  parseLocalPath,
  resolveLocalPath,
} from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

const WINDOWS_ROOT = /^[A-Za-z]:\//;

export type WorkspacePathBindError =
  | { readonly code: "malformed"; readonly reason: LocalPathError["code"] }
  | { readonly code: "escaped" }
  | { readonly code: "absolute-unscoped" };

export type BoundWorkspacePath = {
  readonly root: LocalPath;
  /** Workspace-relative logical form after separator collapse. */
  readonly requested: string;
  readonly resolved: LocalPath;
  /** Path relative to the root; empty string names the root itself. */
  readonly logical: string;
};

function isAbsolutePath(value: string): boolean {
  const forward = value.replace(/\\/g, "/");
  return forward.startsWith("/") || WINDOWS_ROOT.test(forward);
}

function logicalRequested(value: string): string {
  const forward = value.replace(/\\/g, "/");
  if (forward === "" || forward === ".") {
    return ".";
  }
  return forward.replace(/\/+$/, "") || ".";
}

function logicalFromRoot(root: LocalPath, resolved: LocalPath): string {
  if (resolved === root) {
    return "";
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return resolved.slice(prefix.length);
}

export function bindWorkspacePath(
  root: LocalPath,
  value: unknown,
): Result<BoundWorkspacePath, WorkspacePathBindError> {
  if (typeof value !== "string") {
    return err({ code: "malformed", reason: "path-not-a-string" });
  }
  if (value === "" || value === "." || value === "./") {
    return ok({
      root,
      requested: ".",
      resolved: root,
      logical: "",
    });
  }

  const forward = value.replace(/\\/g, "/");
  if (isAbsolutePath(forward)) {
    const parsed = parseLocalPath(value);
    if (!parsed.ok) {
      return err({ code: "malformed", reason: parsed.error.code });
    }
    if (!isInside(root, parsed.value)) {
      return err({ code: "absolute-unscoped" });
    }
    return ok({
      root,
      requested: logicalRequested(value),
      resolved: parsed.value,
      logical: logicalFromRoot(root, parsed.value),
    });
  }

  const resolved = resolveLocalPath(root, value);
  if (!resolved.ok) {
    return err({ code: "malformed", reason: resolved.error.code });
  }
  if (!isInside(root, resolved.value)) {
    return err({ code: "escaped" });
  }
  return ok({
    root,
    requested: logicalRequested(value),
    resolved: resolved.value,
    logical: logicalFromRoot(root, resolved.value),
  });
}

export function describeWorkspacePathBindError(error: WorkspacePathBindError): string {
  switch (error.code) {
    case "malformed":
      return `malformed:${error.reason}`;
    case "escaped":
      return "escaped";
    case "absolute-unscoped":
      return "absolute-unscoped";
    default:
      return assertNever(error, "unhandled workspace path bind error");
  }
}
