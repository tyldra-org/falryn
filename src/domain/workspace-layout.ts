/**
 * Named workspace-layout documents (#605).
 *
 * A layout is `{name, roots[]}` persisted under the user configuration root.
 * This module owns name rules, document shape, and bounded list truncation.
 * Filesystem save/load and root reachability stay in the application seam.
 */

import { z } from "zod";

import { brandedString } from "./branded-schema.ts";
import { type LocalPath, parseLocalPath } from "./filesystem.ts";
import {
  type Brand,
  type IdentifierCodec,
  type IdentityError,
  type WorkspaceRootId,
  workspaceRootId,
} from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { WorkspaceSet } from "./workspace-set.ts";
import { createWorkspaceSet, isLegalWorkspaceRootName } from "./workspace-set.ts";

export type WorkspaceLayoutName = Brand<string, "WorkspaceLayoutName">;

/** Same bound and character class as `--profile` / root display names. */
export const MAX_WORKSPACE_LAYOUT_NAME_LENGTH = 64;
const LEGAL_LAYOUT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const WORKSPACE_LAYOUT_VERSION = "workspace-layout.v1";
export const WORKSPACE_LAYOUT_DIRECTORY = "layouts";
export const WORKSPACE_LAYOUT_EXTENSION = ".jsonc";

export const MAX_WORKSPACE_LAYOUT_CATALOG = 256;
export const DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT = 32;

export const workspaceLayoutName: IdentifierCodec<WorkspaceLayoutName> = {
  identity: "workspaceLayoutName",
  parse(value: unknown): Result<WorkspaceLayoutName, IdentityError> {
    if (typeof value !== "string") {
      return err({
        kind: "identity",
        code: "identifier-not-a-string",
        identity: "workspaceLayoutName",
      });
    }
    if (value.length === 0) {
      return err({
        kind: "identity",
        code: "identifier-empty",
        identity: "workspaceLayoutName",
      });
    }
    if (value.length > MAX_WORKSPACE_LAYOUT_NAME_LENGTH) {
      return err({
        kind: "identity",
        code: "identifier-too-long",
        identity: "workspaceLayoutName",
      });
    }
    if (!LEGAL_LAYOUT_NAME.test(value)) {
      return err({
        kind: "identity",
        code: "identifier-illegal-character",
        identity: "workspaceLayoutName",
      });
    }
    return ok(value as WorkspaceLayoutName);
  },
  from(value: string): WorkspaceLayoutName {
    const parsed = workspaceLayoutName.parse(value);
    if (!parsed.ok) {
      throw new Error(`invalid workspaceLayoutName: ${parsed.error.code}`);
    }
    return parsed.value;
  },
};

export function isLegalWorkspaceLayoutName(name: string): boolean {
  return workspaceLayoutName.parse(name).ok;
}

export type WorkspaceLayoutRoot = {
  readonly rootId: WorkspaceRootId;
  readonly name: string;
  readonly path: LocalPath;
};

export type WorkspaceLayout = {
  readonly version: typeof WORKSPACE_LAYOUT_VERSION;
  readonly name: WorkspaceLayoutName;
  readonly roots: readonly WorkspaceLayoutRoot[];
};

export type WorkspaceLayoutDocumentError =
  | { readonly code: "malformed"; readonly field: string }
  | { readonly code: "invalid-name" }
  | { readonly code: "invalid-root" }
  | { readonly code: "empty-roots" }
  | { readonly code: "name-mismatch" };

export type WorkspaceLayoutCatalogError =
  | { readonly code: "cancelled" }
  | { readonly code: "invalid-limit" };

export type WorkspaceLayoutCatalogEntry = {
  readonly name: WorkspaceLayoutName;
  readonly rootCount: number;
};

export type WorkspaceLayoutCatalog = {
  readonly layouts: readonly WorkspaceLayoutCatalogEntry[];
  readonly omitted: number;
  /** Concrete invocation for the untruncated form, or null when complete. */
  readonly expansion: string | null;
};

const rootSchema = z
  .object({
    rootId: brandedString(workspaceRootId),
    name: z.string().min(1).max(MAX_WORKSPACE_LAYOUT_NAME_LENGTH),
    path: z.string().min(1),
  })
  .strict();

const documentSchema = z
  .object({
    version: z.literal(WORKSPACE_LAYOUT_VERSION),
    name: brandedString(workspaceLayoutName),
    roots: z.array(rootSchema).min(1),
  })
  .strict();

export function workspaceLayoutFileName(name: WorkspaceLayoutName): string {
  return `${name}${WORKSPACE_LAYOUT_EXTENSION}`;
}

export function layoutNameFromFileName(fileName: string): WorkspaceLayoutName | null {
  if (!fileName.endsWith(WORKSPACE_LAYOUT_EXTENSION)) {
    return null;
  }
  const stem = fileName.slice(0, -WORKSPACE_LAYOUT_EXTENSION.length);
  const parsed = workspaceLayoutName.parse(stem);
  return parsed.ok ? parsed.value : null;
}

/**
 * Builds a layout document from a resolved workspace set.
 *
 * Paths must already be absolute. Display names keep the set's unique names.
 */
export function workspaceLayoutFromSet(
  name: WorkspaceLayoutName,
  set: WorkspaceSet,
): Result<WorkspaceLayout, WorkspaceLayoutDocumentError> {
  if (set.roots.length === 0) {
    return err({ code: "empty-roots" });
  }
  const roots: WorkspaceLayoutRoot[] = [];
  for (const root of set.roots) {
    if (!isLegalWorkspaceRootName(root.name)) {
      return err({ code: "invalid-root" });
    }
    roots.push({
      rootId: root.rootId,
      name: root.name,
      path: root.path,
    });
  }
  return ok({ version: WORKSPACE_LAYOUT_VERSION, name, roots });
}

export function workspaceSetFromLayout(
  layout: WorkspaceLayout,
): Result<WorkspaceSet, WorkspaceLayoutDocumentError> {
  const built = createWorkspaceSet(layout.roots);
  if (!built.ok) {
    return err({ code: "invalid-root" });
  }
  return built;
}

export function parseWorkspaceLayoutDocument(
  value: unknown,
  expectedName?: WorkspaceLayoutName,
): Result<WorkspaceLayout, WorkspaceLayoutDocumentError> {
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field =
      issue === undefined
        ? "document"
        : issue.path.length === 0
          ? "document"
          : issue.path.map(String).join(".");
    return err({ code: "malformed", field });
  }
  if (expectedName !== undefined && parsed.data.name !== expectedName) {
    return err({ code: "name-mismatch" });
  }
  const roots: WorkspaceLayoutRoot[] = [];
  for (const root of parsed.data.roots) {
    if (!isLegalWorkspaceRootName(root.name)) {
      return err({ code: "invalid-root" });
    }
    const path = parseLocalPath(root.path);
    if (!path.ok) {
      return err({ code: "invalid-root" });
    }
    roots.push({ rootId: root.rootId, name: root.name, path: path.value });
  }
  return ok({
    version: WORKSPACE_LAYOUT_VERSION,
    name: parsed.data.name,
    roots,
  });
}

export function serializeWorkspaceLayout(layout: WorkspaceLayout): string {
  return `${JSON.stringify(
    {
      version: layout.version,
      name: layout.name as string,
      roots: layout.roots.map((root) => ({
        rootId: root.rootId as string,
        name: root.name,
        path: root.path as string,
      })),
    },
    null,
    2,
  )}\n`;
}

export function queryWorkspaceLayoutCatalog(
  entries: readonly WorkspaceLayoutCatalogEntry[],
  limit: number,
  signal?: AbortSignal,
): Result<WorkspaceLayoutCatalog, WorkspaceLayoutCatalogError> {
  if (signal?.aborted === true) {
    return err({ code: "cancelled" });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKSPACE_LAYOUT_CATALOG) {
    return err({ code: "invalid-limit" });
  }
  const sorted = [...entries].sort((left, right) =>
    (left.name as string).localeCompare(right.name as string),
  );
  const layouts = sorted.slice(0, limit);
  const omitted = Math.max(0, sorted.length - layouts.length);
  return ok({
    layouts,
    omitted,
    expansion: omitted > 0 ? `workspace list --limit ${MAX_WORKSPACE_LAYOUT_CATALOG}` : null,
  });
}

export function describeWorkspaceLayoutDocumentError(error: WorkspaceLayoutDocumentError): string {
  switch (error.code) {
    case "malformed":
      return `malformed:${error.field}`;
    case "invalid-name":
      return "invalid-name";
    case "invalid-root":
      return "invalid-root";
    case "empty-roots":
      return "empty-roots";
    case "name-mismatch":
      return "name-mismatch";
    default:
      return assertNever(error, "unhandled workspace layout document error");
  }
}
