/**
 * Multi-root workspace set identity and path bind (#604).
 *
 * A set is an ordered list of named roots. The primary root is first. Path bind
 * keeps #55 lexical rules per root; this module chooses which root and reports
 * its `rootId`. Symlink escape remains an application probe against the chosen
 * root, not the union of roots.
 */

import { isInside, type LocalPath, type LocalPathError, parseLocalPath } from "./filesystem.ts";
import { type WorkspaceRootId, workspaceRootId } from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import {
  type BoundWorkspacePath,
  bindWorkspacePath,
  type WorkspacePathBindError,
} from "./workspace-path.ts";

/** Display names mirror profile-name rules: no `/`, bounded, no empty string. */
export const MAX_WORKSPACE_ROOT_NAME_LENGTH = 64;

const LEGAL_ROOT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type WorkspaceRootEntry = {
  readonly rootId: WorkspaceRootId;
  readonly name: string;
  /** Absolute path after `realPath`. */
  readonly path: LocalPath;
};

export type WorkspaceSet = {
  /** Ordered roots; index 0 is the primary root. */
  readonly roots: readonly WorkspaceRootEntry[];
};

export type WorkspaceSetError =
  | { readonly code: "empty" }
  | { readonly code: "invalid-name" }
  | { readonly code: "invalid-root-id" }
  | { readonly code: "duplicate-name" }
  | { readonly code: "duplicate-root-id" }
  | { readonly code: "duplicate-path" }
  | { readonly code: "overlapping-roots" }
  | { readonly code: "not-absolute"; readonly reason: LocalPathError["code"] }
  | { readonly code: "unknown-root" }
  | { readonly code: "ambiguous-root" };

export type BoundWorkspaceSetPath = BoundWorkspacePath & {
  readonly rootId: WorkspaceRootId;
};

export type WorkspaceSetBindError = WorkspacePathBindError | WorkspaceSetError;

export type BindWorkspaceSetPathOptions = {
  /** When set, a relative path binds only inside this root. */
  readonly rootId?: WorkspaceRootId;
};

export function isLegalWorkspaceRootName(name: string): boolean {
  return (
    name.length > 0 && name.length <= MAX_WORKSPACE_ROOT_NAME_LENGTH && LEGAL_ROOT_NAME.test(name)
  );
}

export function primaryWorkspaceRoot(set: WorkspaceSet): WorkspaceRootEntry {
  const primary = set.roots[0];
  if (primary === undefined) {
    throw new Error("workspace set has no primary root");
  }
  return primary;
}

/**
 * Builds a workspace set from already-resolved absolute root paths.
 *
 * Callers that need `realPath` do that before this function. Overlap is decided
 * here from the resolved paths so a later bind never has to guess which root
 * owns a path.
 */
export function createWorkspaceSet(
  entries: readonly {
    readonly rootId: unknown;
    readonly name: unknown;
    readonly path: unknown;
  }[],
): Result<WorkspaceSet, WorkspaceSetError> {
  if (entries.length === 0) {
    return err({ code: "empty" });
  }

  const roots: WorkspaceRootEntry[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  const paths: LocalPath[] = [];

  for (const entry of entries) {
    if (typeof entry.name !== "string" || !isLegalWorkspaceRootName(entry.name)) {
      return err({ code: "invalid-name" });
    }
    if (names.has(entry.name)) {
      return err({ code: "duplicate-name" });
    }
    const id = workspaceRootId.parse(entry.rootId);
    if (!id.ok) {
      return err({ code: "invalid-root-id" });
    }
    if (ids.has(id.value)) {
      return err({ code: "duplicate-root-id" });
    }
    const parsed = parseLocalPath(entry.path);
    if (!parsed.ok) {
      return err({ code: "not-absolute", reason: parsed.error.code });
    }
    for (const existing of paths) {
      if (existing === parsed.value) {
        return err({ code: "duplicate-path" });
      }
      if (isInside(existing, parsed.value) || isInside(parsed.value, existing)) {
        return err({ code: "overlapping-roots" });
      }
    }
    names.add(entry.name);
    ids.add(id.value);
    paths.push(parsed.value);
    roots.push({ rootId: id.value, name: entry.name, path: parsed.value });
  }

  return ok({ roots });
}

function rootById(set: WorkspaceSet, id: WorkspaceRootId): WorkspaceRootEntry | null {
  return set.roots.find((root) => root.rootId === id) ?? null;
}

function rootsContaining(set: WorkspaceSet, absolute: LocalPath): readonly WorkspaceRootEntry[] {
  return set.roots.filter((root) => isInside(root.path, absolute));
}

/**
 * Binds a tool path against a workspace set.
 *
 * Relative paths without `rootId` use the primary root. Absolute paths must
 * land in exactly one root. Rejected text is never returned on the error.
 */
export function bindWorkspaceSetPath(
  set: WorkspaceSet,
  value: unknown,
  options: BindWorkspaceSetPathOptions = {},
): Result<BoundWorkspaceSetPath, WorkspaceSetBindError> {
  if (set.roots.length === 0) {
    return err({ code: "empty" });
  }

  if (options.rootId !== undefined) {
    const chosen = rootById(set, options.rootId);
    if (chosen === null) {
      return err({ code: "unknown-root" });
    }
    const bound = bindWorkspacePath(chosen.path, value);
    if (!bound.ok) {
      return bound;
    }
    return ok({ ...bound.value, rootId: chosen.rootId });
  }

  if (typeof value === "string") {
    const forward = value.replace(/\\/g, "/");
    const absolute = forward.startsWith("/") || /^[A-Za-z]:\//.test(forward);
    if (absolute) {
      const parsed = parseLocalPath(value);
      if (!parsed.ok) {
        return err({ code: "malformed", reason: parsed.error.code });
      }
      const matches = rootsContaining(set, parsed.value);
      if (matches.length === 0) {
        return err({ code: "absolute-unscoped" });
      }
      if (matches.length > 1) {
        return err({ code: "ambiguous-root" });
      }
      const chosen = matches[0];
      if (chosen === undefined) {
        return err({ code: "absolute-unscoped" });
      }
      const bound = bindWorkspacePath(chosen.path, value);
      if (!bound.ok) {
        return bound;
      }
      return ok({ ...bound.value, rootId: chosen.rootId });
    }
  }

  const primary = primaryWorkspaceRoot(set);
  const bound = bindWorkspacePath(primary.path, value);
  if (!bound.ok) {
    return bound;
  }
  return ok({ ...bound.value, rootId: primary.rootId });
}

export function describeWorkspaceSetError(error: WorkspaceSetError): string {
  switch (error.code) {
    case "empty":
      return "empty";
    case "invalid-name":
      return "invalid-name";
    case "invalid-root-id":
      return "invalid-root-id";
    case "duplicate-name":
      return "duplicate-name";
    case "duplicate-root-id":
      return "duplicate-root-id";
    case "duplicate-path":
      return "duplicate-path";
    case "overlapping-roots":
      return "overlapping-roots";
    case "not-absolute":
      return `not-absolute:${error.reason}`;
    case "unknown-root":
      return "unknown-root";
    case "ambiguous-root":
      return "ambiguous-root";
    default:
      return assertNever(error, "unhandled workspace set error");
  }
}

export function describeWorkspaceSetBindError(error: WorkspaceSetBindError): string {
  if (
    error.code === "malformed" ||
    error.code === "escaped" ||
    error.code === "absolute-unscoped"
  ) {
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
  return describeWorkspaceSetError(error);
}
