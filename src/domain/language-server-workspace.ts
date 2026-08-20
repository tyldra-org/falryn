/**
 * Product workspace-set → language-server folder mapping (#608).
 *
 * Converts named bound roots into the LSP workspace-folder list that #90’s
 * `changeWorkspaceFolders` already accepts. Documents and diagnostics stay
 * keyed by URI on the wire; this module attributes a URI to one `rootId`.
 * Overlapping roots are refused when the set is built, so URI lookup never
 * guesses.
 */

import { type LocalPath, parseLocalPath } from "./filesystem.ts";
import type { ConfigurationGeneration, WorkspaceRootId } from "./identity.ts";
import type {
  LanguageServerWorkspaceFolder,
  LanguageServerWorkspaceFoldersChange,
} from "./language-server-sync.ts";
import { MAX_LANGUAGE_SERVER_WORKSPACE_FOLDERS } from "./language-server-sync.ts";
import { err, ok, type Result } from "./result.ts";
import type { WorkspaceRootEntry, WorkspaceSet } from "./workspace-set.ts";

export type ProductLanguageServerFolder = {
  readonly rootId: WorkspaceRootId;
  readonly name: string;
  readonly path: LocalPath;
  /** `file://` URI passed to the language server. */
  readonly uri: string;
};

export type LanguageServerWorkspaceMapError =
  | { readonly code: "invalid-uri" }
  | { readonly code: "unscoped" }
  | { readonly code: "ambiguous-root" }
  | { readonly code: "too-many-folders" };

export type WorkspaceFolderSyncSnapshot = {
  readonly configurationGeneration: ConfigurationGeneration;
  readonly set: WorkspaceSet;
};

/**
 * Absolute local path → LSP `file://` URI.
 *
 * Matches the decode rules in `fileUriToWorkspaceRelativePath`: POSIX paths
 * keep a leading slash; Windows drive paths are encoded without an extra slash
 * after `file://` so round-trips stay stable.
 */
export function localPathToFileUri(path: LocalPath): string {
  const text = path as string;
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    const normalized = text.replace(/\\/g, "/");
    return `file:///${encodeUriPath(normalized)}`;
  }
  if (text.startsWith("/")) {
    return `file://${encodeUriPath(text)}`;
  }
  return `file:///${encodeUriPath(text)}`;
}

function encodeUriPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.length === 0 ? "" : encodeURIComponent(segment)))
    .join("/");
}

export function fileUriToAbsolutePath(
  uri: string,
): Result<string, LanguageServerWorkspaceMapError> {
  if (!uri.startsWith("file://")) {
    return err({ code: "invalid-uri" });
  }
  let path = decodeURIComponent(uri.slice("file://".length));
  if (path.startsWith("/") && /^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
  }
  if (path.length === 0 || path.includes("\0")) {
    return err({ code: "invalid-uri" });
  }
  return ok(path);
}

export function productFolderFromRoot(root: WorkspaceRootEntry): ProductLanguageServerFolder {
  return {
    rootId: root.rootId,
    name: root.name,
    path: root.path,
    uri: localPathToFileUri(root.path),
  };
}

export function productFoldersFromWorkspaceSet(
  set: WorkspaceSet,
): Result<readonly ProductLanguageServerFolder[], LanguageServerWorkspaceMapError> {
  if (set.roots.length > MAX_LANGUAGE_SERVER_WORKSPACE_FOLDERS) {
    return err({ code: "too-many-folders" });
  }
  return ok(set.roots.map(productFolderFromRoot));
}

/** LSP folder list for initialize / didChangeWorkspaceFolders. */
export function languageServerFoldersFromWorkspaceSet(
  set: WorkspaceSet,
): Result<readonly LanguageServerWorkspaceFolder[], LanguageServerWorkspaceMapError> {
  const product = productFoldersFromWorkspaceSet(set);
  if (!product.ok) {
    return product;
  }
  return ok(product.value.map((folder) => ({ uri: folder.uri, name: folder.name })));
}

/**
 * Diff two product sets into an LSP folder change.
 *
 * Returns `null` when the folder list is identical (same URIs and names in the
 * same order), so callers skip a no-op notification. Removal matches by URI.
 */
export function workspaceSetFolderChange(
  previous: WorkspaceSet | null,
  next: WorkspaceSet,
): Result<LanguageServerWorkspaceFoldersChange | null, LanguageServerWorkspaceMapError> {
  const nextFolders = productFoldersFromWorkspaceSet(next);
  if (!nextFolders.ok) {
    return nextFolders;
  }
  let previousFolders: readonly ProductLanguageServerFolder[] = [];
  if (previous !== null) {
    const mapped = productFoldersFromWorkspaceSet(previous);
    if (!mapped.ok) {
      return mapped;
    }
    previousFolders = mapped.value;
  }

  const previousByUri = new Map(previousFolders.map((folder) => [folder.uri, folder]));
  const nextByUri = new Map(nextFolders.value.map((folder) => [folder.uri, folder]));

  const added: LanguageServerWorkspaceFolder[] = [];
  const removed: LanguageServerWorkspaceFolder[] = [];

  for (const folder of nextFolders.value) {
    const prior = previousByUri.get(folder.uri);
    if (prior === undefined) {
      added.push({ uri: folder.uri, name: folder.name });
      continue;
    }
    if (prior.name !== folder.name) {
      removed.push({ uri: prior.uri, name: prior.name });
      added.push({ uri: folder.uri, name: folder.name });
    }
  }
  for (const folder of previousFolders) {
    if (!nextByUri.has(folder.uri)) {
      removed.push({ uri: folder.uri, name: folder.name });
    }
  }

  if (added.length === 0 && removed.length === 0) {
    return ok(null);
  }
  if (added.length + removed.length > MAX_LANGUAGE_SERVER_WORKSPACE_FOLDERS) {
    return err({ code: "too-many-folders" });
  }
  return ok({ added, removed });
}

/**
 * Whether a new product set + configuration generation should drive a folder
 * sync. Generation changes always resync even when the folder list is equal,
 * so servers observe the product configuration move.
 */
export function shouldSyncLanguageServerFolders(
  current: WorkspaceFolderSyncSnapshot | null,
  next: WorkspaceFolderSyncSnapshot,
): boolean {
  if (current === null) {
    return true;
  }
  if (current.configurationGeneration !== next.configurationGeneration) {
    return true;
  }
  return !workspaceSetsEqualByFolders(current.set, next.set);
}

function workspaceSetsEqualByFolders(left: WorkspaceSet, right: WorkspaceSet): boolean {
  if (left.roots.length !== right.roots.length) {
    return false;
  }
  return left.roots.every((root, index) => {
    const other = right.roots[index];
    return (
      other !== undefined &&
      root.rootId === other.rootId &&
      root.name === other.name &&
      (root.path as string) === (other.path as string)
    );
  });
}

/**
 * Attributes a document URI to exactly one bound root.
 *
 * Longest matching root path wins when one root is a prefix of another — but
 * overlapping roots are refused at set build, so that case should not arise.
 */
export function rootIdForDocumentUri(
  uri: string,
  set: WorkspaceSet,
): Result<WorkspaceRootId, LanguageServerWorkspaceMapError> {
  const absolute = fileUriToAbsolutePath(uri);
  if (!absolute.ok) {
    return absolute;
  }
  const pathText = absolute.value.replace(/\\/g, "/");
  const matches: WorkspaceRootEntry[] = [];
  for (const root of set.roots) {
    const rootText = (root.path as string).replace(/\\/g, "/");
    if (pathText === rootText) {
      matches.push(root);
      continue;
    }
    const prefix = rootText.endsWith("/") ? rootText : `${rootText}/`;
    if (pathText.startsWith(prefix)) {
      matches.push(root);
    }
  }
  if (matches.length === 0) {
    return err({ code: "unscoped" });
  }
  if (matches.length > 1) {
    // Prefer the longest root path so a nested match is unambiguous if overlap
    // ever slipped past set construction.
    matches.sort((left, right) => (right.path as string).length - (left.path as string).length);
    const best = matches[0];
    const second = matches[1];
    if (
      best === undefined ||
      second === undefined ||
      (best.path as string).length === (second.path as string).length
    ) {
      return err({ code: "ambiguous-root" });
    }
    return ok(best.rootId);
  }
  const only = matches[0];
  if (only === undefined) {
    return err({ code: "unscoped" });
  }
  return ok(only.rootId);
}

/** Bind a workspace-relative path under a known root for open-document URIs. */
export function documentUriUnderRoot(root: WorkspaceRootEntry, relativePath: string): string {
  const base = (root.path as string).replace(/\/+$/, "");
  const relative = relativePath.replace(/^\/+/, "").replace(/\\/g, "/");
  const joined = relative.length === 0 ? base : `${base}/${relative}`;
  const parsed = parseLocalPath(joined);
  if (!parsed.ok) {
    return localPathToFileUri(root.path);
  }
  return localPathToFileUri(parsed.value);
}
