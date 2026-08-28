/**
 * Compatibility selection for Falryn's human-authored configuration home.
 *
 * Reads never create or move anything. Writes may move the complete legacy
 * directory to the current home, but only when one side contains data. Two
 * populated homes are a conflict, not an invitation to invent merge rules.
 */

import type { ConfigurationIssue, FileSystemPort, LocalPath } from "../domain/index.ts";

export type ConfigurationHomeRoots = {
  /** Current user-authored home, normally `~/.falryn`. */
  readonly current: LocalPath;
  /** Previous platform-default home, or `null` under an explicit override. */
  readonly legacy: LocalPath | null;
};

type SelectedConfigurationHome =
  | {
      readonly kind: "current";
      readonly root: LocalPath;
      readonly currentRoot: LocalPath;
      readonly legacyRoot: LocalPath | null;
    }
  | {
      readonly kind: "legacy";
      readonly root: LocalPath;
      readonly currentRoot: LocalPath;
      readonly legacyRoot: LocalPath;
    }
  | {
      readonly kind: "empty";
      readonly root: LocalPath;
      readonly currentRoot: LocalPath;
      readonly legacyRoot: LocalPath | null;
    };

type ConfigurationHomeIoFailure =
  | {
      readonly kind: "unavailable";
      readonly path: LocalPath;
      readonly code: string;
    }
  | { readonly kind: "cancelled" };

type ConfigurationHomeFailure =
  | {
      readonly kind: "conflict";
      readonly currentRoot: LocalPath;
      readonly legacyRoot: LocalPath;
    }
  | ConfigurationHomeIoFailure;

export type ConfigurationHomeResolution = SelectedConfigurationHome | ConfigurationHomeFailure;

export type ConfigurationHomeWriteResolution =
  | {
      readonly kind: "ready";
      readonly root: LocalPath;
      readonly migrated: boolean;
    }
  | ConfigurationHomeFailure;

type InspectedHome =
  | { readonly kind: "absent" | "empty" | "populated" }
  | ConfigurationHomeIoFailure;

/** Selects the effective read home without creating or mutating either path. */
export async function resolveConfigurationHome(
  fileSystem: FileSystemPort,
  roots: ConfigurationHomeRoots,
  signal?: AbortSignal,
): Promise<ConfigurationHomeResolution> {
  const current = await inspectHome(fileSystem, roots.current, signal);
  if (current.kind === "cancelled" || current.kind === "unavailable") {
    return current;
  }

  if (roots.legacy === null || roots.legacy === roots.current) {
    return selected(current.kind === "populated" ? "current" : "empty", roots.current, roots);
  }

  const legacy = await inspectHome(fileSystem, roots.legacy, signal);
  if (legacy.kind === "cancelled" || legacy.kind === "unavailable") {
    return legacy;
  }

  if (current.kind === "populated" && legacy.kind === "populated") {
    return {
      kind: "conflict",
      currentRoot: roots.current,
      legacyRoot: roots.legacy,
    };
  }
  if (legacy.kind === "populated") {
    return selected("legacy", roots.legacy, roots);
  }
  return selected(current.kind === "populated" ? "current" : "empty", roots.current, roots);
}

/**
 * Returns the current write home, migrating a populated legacy home exactly
 * once when it is the only source of configuration data.
 */
export async function prepareConfigurationHomeForWrite(
  fileSystem: FileSystemPort,
  roots: ConfigurationHomeRoots,
  signal?: AbortSignal,
): Promise<ConfigurationHomeWriteResolution> {
  const resolved = await resolveConfigurationHome(fileSystem, roots, signal);
  switch (resolved.kind) {
    case "current":
    case "empty":
      return { kind: "ready", root: roots.current, migrated: false };
    case "conflict":
    case "unavailable":
    case "cancelled":
      return resolved;
    case "legacy": {
      const current = await fileSystem.stat(roots.current, signal);
      if (!current.ok) {
        return failureFromFileSystem(current.error.path, current.error.code);
      }
      if (current.value !== null) {
        const removed = await fileSystem.removeEntry(roots.current, signal);
        if (!removed.ok) {
          return failureFromFileSystem(removed.error.path, removed.error.code);
        }
      }

      const moved = await fileSystem.renameEntry(resolved.root, roots.current, signal);
      if (!moved.ok) {
        return failureFromFileSystem(moved.error.path, moved.error.code);
      }
      return { kind: "ready", root: roots.current, migrated: true };
    }
  }
}

/** Converts home-selection failures into the configuration issue vocabulary. */
export function configurationHomeIssue(
  outcome: Extract<ConfigurationHomeResolution, { readonly kind: "conflict" | "unavailable" }>,
): ConfigurationIssue {
  switch (outcome.kind) {
    case "conflict":
      return {
        kind: "configuration-home-conflict",
        severity: "error",
        path: outcome.currentRoot,
        legacyPath: outcome.legacyRoot,
      };
    case "unavailable":
      return {
        kind: "configuration-home-unavailable",
        severity: "error",
        path: outcome.path,
        code: outcome.code,
      };
  }
}

function selected(
  kind: "current" | "legacy" | "empty",
  root: LocalPath,
  roots: ConfigurationHomeRoots,
): SelectedConfigurationHome {
  switch (kind) {
    case "current":
      return { kind, root, currentRoot: roots.current, legacyRoot: roots.legacy };
    case "legacy":
      return {
        kind,
        root,
        currentRoot: roots.current,
        legacyRoot: roots.legacy ?? root,
      };
    case "empty":
      return { kind, root, currentRoot: roots.current, legacyRoot: roots.legacy };
  }
}

async function inspectHome(
  fileSystem: FileSystemPort,
  path: LocalPath,
  signal?: AbortSignal,
): Promise<InspectedHome> {
  const stated = await fileSystem.stat(path, signal);
  if (!stated.ok) {
    return failureFromFileSystem(stated.error.path, stated.error.code);
  }
  if (stated.value === null) {
    return { kind: "absent" };
  }
  if (stated.value.kind !== "directory") {
    return { kind: "unavailable", path, code: "not-a-directory" };
  }

  const listed = await fileSystem.list(path, signal);
  if (!listed.ok) {
    return failureFromFileSystem(listed.error.path, listed.error.code);
  }
  return { kind: listed.value.length === 0 ? "empty" : "populated" };
}

function failureFromFileSystem(path: LocalPath, code: string): ConfigurationHomeIoFailure {
  return code === "cancelled" ? { kind: "cancelled" } : { kind: "unavailable", path, code };
}
