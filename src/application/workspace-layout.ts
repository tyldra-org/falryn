/**
 * Persist named workspace layouts under the user configuration root (#605).
 *
 * Save records resolved absolute paths. Load reconstructs a workspace set and
 * fails closed when any stored root is missing or not a directory, naming every
 * unusable path. List is bounded with a concrete expansion route.
 */

import { MAX_CONFIGURATION_FILE_BYTES, parseJsonc } from "../config/jsonc.ts";
import {
  createWorkspaceSet,
  DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT,
  type FileSystemError,
  type FileSystemPort,
  type IdentityError,
  joinPath,
  type LocalPath,
  layoutNameFromFileName,
  parseWorkspaceLayoutDocument,
  queryWorkspaceLayoutCatalog,
  type Result,
  serializeWorkspaceLayout,
  WORKSPACE_LAYOUT_DIRECTORY,
  type WorkspaceLayout,
  type WorkspaceLayoutCatalog,
  type WorkspaceLayoutCatalogEntry,
  type WorkspaceLayoutDocumentError,
  type WorkspaceLayoutName,
  type WorkspaceSet,
  type WorkspaceSetError,
  workspaceLayoutFileName,
  workspaceLayoutFromSet,
  workspaceLayoutName,
} from "../domain/index.ts";

export type WorkspaceLayoutUnusableRoot = {
  readonly path: string;
  readonly reason: "missing" | "not-directory" | "not-absolute" | "filesystem";
};

export type WorkspaceLayoutStoreError =
  | { readonly code: "cancelled" }
  | { readonly code: "invalid-name"; readonly error: IdentityError }
  | { readonly code: "document"; readonly error: WorkspaceLayoutDocumentError }
  | { readonly code: "set"; readonly error: WorkspaceSetError }
  | { readonly code: "not-found" }
  | { readonly code: "exists" }
  | { readonly code: "unusable-roots"; readonly unusable: readonly WorkspaceLayoutUnusableRoot[] }
  | { readonly code: "malformed-file" }
  | { readonly code: "filesystem"; readonly error: FileSystemError }
  | { readonly code: "invalid-limit" }
  | { readonly code: "path" };

export type WorkspaceLayoutStore = {
  save(
    name: unknown,
    set: WorkspaceSet,
    options?: { readonly force?: boolean; readonly signal?: AbortSignal },
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceLayout }
    | { readonly ok: false; readonly error: WorkspaceLayoutStoreError }
  >;
  load(
    name: unknown,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly ok: true;
        readonly value: { readonly layout: WorkspaceLayout; readonly set: WorkspaceSet };
      }
    | { readonly ok: false; readonly error: WorkspaceLayoutStoreError }
  >;
  list(options?: {
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly ok: true; readonly value: WorkspaceLayoutCatalog }
    | { readonly ok: false; readonly error: WorkspaceLayoutStoreError }
  >;
};

function layoutsDirectory(
  configurationRoot: LocalPath,
): Result<LocalPath, WorkspaceLayoutStoreError> {
  const joined = joinPath(configurationRoot, WORKSPACE_LAYOUT_DIRECTORY);
  return joined.ok ? joined : { ok: false, error: { code: "path" } };
}

function layoutFile(
  configurationRoot: LocalPath,
  name: WorkspaceLayoutName,
): Result<LocalPath, WorkspaceLayoutStoreError> {
  const directory = layoutsDirectory(configurationRoot);
  if (!directory.ok) {
    return directory;
  }
  const joined = joinPath(directory.value, workspaceLayoutFileName(name));
  return joined.ok ? joined : { ok: false, error: { code: "path" } };
}

async function ensureLayoutsDirectory(
  fileSystem: FileSystemPort,
  configurationRoot: LocalPath,
  signal?: AbortSignal,
): Promise<Result<LocalPath, WorkspaceLayoutStoreError>> {
  const directory = layoutsDirectory(configurationRoot);
  if (!directory.ok) {
    return directory;
  }
  const created = await fileSystem.createDirectory(directory.value, 0o700, signal);
  if (!created.ok) {
    if (created.error.code === "cancelled") {
      return { ok: false, error: { code: "cancelled" } };
    }
    return { ok: false, error: { code: "filesystem", error: created.error } };
  }
  return directory;
}

export function createWorkspaceLayoutStore(
  fileSystem: FileSystemPort,
  configurationRoot: LocalPath,
): WorkspaceLayoutStore {
  return {
    async save(name, set, options = {}) {
      if (options.signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsedName = workspaceLayoutName.parse(name);
      if (!parsedName.ok) {
        return { ok: false, error: { code: "invalid-name", error: parsedName.error } };
      }
      const layout = workspaceLayoutFromSet(parsedName.value, set);
      if (!layout.ok) {
        return { ok: false, error: { code: "document", error: layout.error } };
      }
      const directory = await ensureLayoutsDirectory(fileSystem, configurationRoot, options.signal);
      if (!directory.ok) {
        return directory;
      }
      const file = layoutFile(configurationRoot, parsedName.value);
      if (!file.ok) {
        return file;
      }
      const existing = await fileSystem.stat(file.value, options.signal);
      if (!existing.ok) {
        if (existing.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        return { ok: false, error: { code: "filesystem", error: existing.error } };
      }
      if (existing.value !== null && options.force !== true) {
        return { ok: false, error: { code: "exists" } };
      }
      const bytes = new TextEncoder().encode(serializeWorkspaceLayout(layout.value));
      const written = await fileSystem.writeBytes(file.value, bytes, options.signal);
      if (!written.ok) {
        if (written.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        return { ok: false, error: { code: "filesystem", error: written.error } };
      }
      return { ok: true, value: layout.value };
    },

    async load(name, signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsedName = workspaceLayoutName.parse(name);
      if (!parsedName.ok) {
        return { ok: false, error: { code: "invalid-name", error: parsedName.error } };
      }
      const file = layoutFile(configurationRoot, parsedName.value);
      if (!file.ok) {
        return file;
      }
      const text = await fileSystem.readText(file.value, MAX_CONFIGURATION_FILE_BYTES, signal);
      if (!text.ok) {
        if (text.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        if (text.error.code === "not-found") {
          return { ok: false, error: { code: "not-found" } };
        }
        return { ok: false, error: { code: "filesystem", error: text.error } };
      }
      const parsedJson = parseJsonc(text.value);
      if (!parsedJson.ok) {
        return { ok: false, error: { code: "malformed-file" } };
      }
      const document = parseWorkspaceLayoutDocument(parsedJson.value, parsedName.value);
      if (!document.ok) {
        return { ok: false, error: { code: "document", error: document.error } };
      }

      const unusable: WorkspaceLayoutUnusableRoot[] = [];
      const resolved: {
        readonly rootId: WorkspaceLayout["roots"][number]["rootId"];
        readonly name: string;
        readonly path: LocalPath;
      }[] = [];
      for (const root of document.value.roots) {
        const real = await fileSystem.realPath(root.path, signal);
        if (!real.ok) {
          if (real.error.code === "cancelled") {
            return { ok: false, error: { code: "cancelled" } };
          }
          if (real.error.code === "not-found") {
            unusable.push({ path: root.path as string, reason: "missing" });
          } else {
            unusable.push({ path: root.path as string, reason: "filesystem" });
          }
          continue;
        }
        const statted = await fileSystem.stat(real.value, signal);
        if (!statted.ok) {
          if (statted.error.code === "cancelled") {
            return { ok: false, error: { code: "cancelled" } };
          }
          unusable.push({ path: root.path as string, reason: "filesystem" });
          continue;
        }
        if (statted.value === null) {
          unusable.push({ path: root.path as string, reason: "missing" });
          continue;
        }
        if (statted.value.kind !== "directory") {
          unusable.push({ path: root.path as string, reason: "not-directory" });
          continue;
        }
        resolved.push({ rootId: root.rootId, name: root.name, path: real.value });
      }
      if (unusable.length > 0) {
        return { ok: false, error: { code: "unusable-roots", unusable } };
      }
      const set = createWorkspaceSet(resolved);
      if (!set.ok) {
        return { ok: false, error: { code: "set", error: set.error } };
      }
      return { ok: true, value: { layout: document.value, set: set.value } };
    },

    async list(options = {}) {
      if (options.signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const directory = layoutsDirectory(configurationRoot);
      if (!directory.ok) {
        return directory;
      }
      const listed = await fileSystem.list(directory.value, options.signal);
      if (!listed.ok) {
        if (listed.error.code === "cancelled") {
          return { ok: false, error: { code: "cancelled" } };
        }
        if (listed.error.code === "not-found") {
          const empty = queryWorkspaceLayoutCatalog(
            [],
            options.limit ?? DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT,
            options.signal,
          );
          if (!empty.ok) {
            return {
              ok: false,
              error: {
                code: empty.error.code === "invalid-limit" ? "invalid-limit" : "cancelled",
              },
            };
          }
          return empty;
        }
        return { ok: false, error: { code: "filesystem", error: listed.error } };
      }

      const entries: WorkspaceLayoutCatalogEntry[] = [];
      for (const entry of listed.value) {
        if (entry.kind !== "file") {
          continue;
        }
        const segments = (entry.path as string).split("/");
        const fileName = segments[segments.length - 1];
        if (fileName === undefined) {
          continue;
        }
        const name = layoutNameFromFileName(fileName);
        if (name === null) {
          continue;
        }
        const file = layoutFile(configurationRoot, name);
        if (!file.ok) {
          continue;
        }
        const text = await fileSystem.readText(
          file.value,
          MAX_CONFIGURATION_FILE_BYTES,
          options.signal,
        );
        if (!text.ok) {
          if (text.error.code === "cancelled") {
            return { ok: false, error: { code: "cancelled" } };
          }
          continue;
        }
        const parsedJson = parseJsonc(text.value);
        if (!parsedJson.ok) {
          continue;
        }
        const document = parseWorkspaceLayoutDocument(parsedJson.value, name);
        if (!document.ok) {
          continue;
        }
        entries.push({ name, rootCount: document.value.roots.length });
      }

      const catalog = queryWorkspaceLayoutCatalog(
        entries,
        options.limit ?? DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT,
        options.signal,
      );
      if (!catalog.ok) {
        return {
          ok: false,
          error: { code: catalog.error.code === "invalid-limit" ? "invalid-limit" : "cancelled" },
        };
      }
      return catalog;
    },
  };
}
