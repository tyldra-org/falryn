/**
 * Sync language-server workspace folders from the product workspace set (#608).
 *
 * Owns the bridge from {@link WorkspaceSet} to #90’s
 * `changeWorkspaceFolders`. The language layer does not invent a second
 * folder picker.
 */

import {
  type ConfigurationGeneration,
  err,
  type LanguageServerError,
  type LanguageServerSnapshot,
  type LanguageServerWorkspaceFolder,
  type LanguageServerWorkspaceMapError,
  languageServerFoldersFromWorkspaceSet,
  type ManagedServiceId,
  ok,
  type Result,
  type ServiceGeneration,
  shouldSyncLanguageServerFolders,
  type WorkspaceFolderSyncSnapshot,
  type WorkspaceSet,
  workspaceSetFolderChange,
} from "../domain/index.ts";
import type { LanguageServerSupervisor } from "./language-server.ts";

export type SyncLanguageServerFoldersRequest = {
  readonly supervisor: LanguageServerSupervisor;
  readonly serviceId: ManagedServiceId;
  readonly generation: ServiceGeneration;
  readonly previous: WorkspaceFolderSyncSnapshot | null;
  readonly next: WorkspaceFolderSyncSnapshot;
};

export type SyncLanguageServerFoldersResult = {
  readonly snapshot: LanguageServerSnapshot | null;
  readonly synced: WorkspaceFolderSyncSnapshot;
  /** True when `changeWorkspaceFolders` was called. */
  readonly notified: boolean;
};

export type SyncLanguageServerFoldersError =
  | LanguageServerError
  | { readonly kind: "workspace-map"; readonly error: LanguageServerWorkspaceMapError };

export function describeLanguageServerWorkspaceMapError(
  error: LanguageServerWorkspaceMapError,
): string {
  switch (error.code) {
    case "invalid-uri":
      return "That document URI is not a usable file path.";
    case "unscoped":
      return "That document is outside every bound workspace root.";
    case "ambiguous-root":
      return "That document matches more than one workspace root.";
    case "too-many-folders":
      return "Too many workspace folders for the language server.";
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

/** Initialize-params folder list from a product set (primary first). */
export function initializeFoldersFromWorkspaceSet(
  set: WorkspaceSet,
): Result<readonly LanguageServerWorkspaceFolder[], LanguageServerWorkspaceMapError> {
  return languageServerFoldersFromWorkspaceSet(set);
}

/**
 * Applies the product set through `changeWorkspaceFolders` when the folder
 * list or configuration generation changed.
 */
export async function syncLanguageServerFoldersFromWorkspaceSet(
  request: SyncLanguageServerFoldersRequest,
): Promise<Result<SyncLanguageServerFoldersResult, SyncLanguageServerFoldersError>> {
  const { previous, next } = request;
  if (!shouldSyncLanguageServerFolders(previous, next)) {
    return ok({
      snapshot: null,
      synced: next,
      notified: false,
    });
  }

  const change = workspaceSetFolderChange(previous?.set ?? null, next.set);
  if (!change.ok) {
    return err({ kind: "workspace-map", error: change.error });
  }

  if (change.value === null) {
    // Generation moved without a folder-list delta — still record the sync.
    return ok({
      snapshot: null,
      synced: next,
      notified: false,
    });
  }

  const applied = await request.supervisor.changeWorkspaceFolders(
    request.serviceId,
    request.generation,
    change.value,
  );
  if (!applied.ok) {
    return applied;
  }
  return ok({
    snapshot: applied.value,
    synced: next,
    notified: true,
  });
}

export function workspaceFolderSyncSnapshot(
  set: WorkspaceSet,
  configurationGeneration: ConfigurationGeneration,
): WorkspaceFolderSyncSnapshot {
  return { set, configurationGeneration };
}
