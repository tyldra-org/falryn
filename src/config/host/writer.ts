/**
 * Validated configuration file writes through {@link FileSystemPort}.
 *
 * A value is coerced and validated against the registry before any byte is
 * written. An invalid candidate refuses the whole file rather than publishing a
 * partial edit. Writes are atomic through `writeBytes` and may carry an
 * expected revision to detect concurrent change.
 */

import type {
  ConfigurationIssue,
  ConfigurationRegistryPort,
  ConfigurationScope,
  ConfigurationValue,
} from "../../domain/configuration/index.ts";
import { err, ok, type Result } from "../../domain/foundation/index.ts";
import {
  type FileSystemPort,
  joinPath,
  type LocalPath,
  parentPath,
} from "../../domain/workspace/index.ts";
import { planConfigurationEdits } from "../document/edits.ts";
import { MAX_CONFIGURATION_FILE_BYTES } from "../document/jsonc.ts";
import { readOverrideLayer } from "../resolution/bridges.ts";
import {
  CONFIGURATION_FILE_NAME,
  discoverSources,
  isLegalProfileName,
  PROFILE_DIRECTORY,
  PROJECT_CONFIGURATION_DIRECTORY,
} from "../resolution/sources.ts";
import {
  configurationHomeIssue,
  prepareConfigurationHomeForWrite,
  resolveConfigurationHome,
} from "./home.ts";

export type ConfigurationFileScope = "user" | "project" | "profile";

export type ConfigurationWriteRequest = {
  readonly configurationRoot: LocalPath;
  /** Previous platform-default root; `null` disables compatibility migration. */
  readonly legacyConfigurationRoot?: LocalPath | null;
  readonly workspaceRoot: LocalPath | null;
  readonly profile: string | null;
  readonly scope: ConfigurationFileScope;
  readonly keyPath: string;
  readonly rawValue: string;
  readonly operation?: "remove";
  /** When set, the file must still have this revision or the write is refused. */
  readonly expectedRevision?: string | null;
  readonly onMutationStart?: () => void;
  readonly validateCandidate?: (
    path: LocalPath,
    text: string,
    signal?: AbortSignal,
  ) => Promise<readonly ConfigurationIssue[]>;
};

/** A typed value write used by product-owned configuration actions. */
export type ConfigurationValueWriteRequest = Omit<ConfigurationWriteRequest, "rawValue"> & {
  readonly value: ConfigurationValue;
  /** Refuse when a file appeared after the caller observed it absent. */
  readonly requireAbsent?: boolean;
};

export type ConfigurationWriteOutcome =
  | {
      readonly kind: "unchanged";
      readonly path: LocalPath;
      readonly revision: null;
      readonly byteLength: 0;
      readonly previousRevision: null;
      readonly changedPaths: readonly string[];
      readonly validation: "valid";
      readonly save: "unchanged";
      readonly publication: "pending";
      readonly application: "pending";
    }
  | {
      readonly kind: "written";
      readonly path: LocalPath;
      readonly revision: string;
      readonly byteLength: number;
      readonly previousRevision: string | null;
      readonly changedPaths: readonly string[];
      readonly validation: "valid";
      readonly save: "saved" | "unchanged";
      readonly publication: "pending";
      readonly application: "pending";
    }
  | { readonly kind: "rejected"; readonly issues: readonly ConfigurationIssue[] }
  | { readonly kind: "stale-write"; readonly path: LocalPath }
  | { readonly kind: "workspace-required" }
  | { readonly kind: "profile-required" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "filesystem"; readonly path: LocalPath; readonly code: string };

const SCOPE_BY_FILE: Readonly<Record<ConfigurationFileScope, ConfigurationScope>> = {
  user: "user",
  project: "project",
  profile: "profile",
};

export function resolveConfigurationFilePath(
  request: Pick<
    ConfigurationWriteRequest,
    "configurationRoot" | "workspaceRoot" | "profile" | "scope"
  >,
): Result<LocalPath, ConfigurationWriteOutcome> {
  switch (request.scope) {
    case "user": {
      const file = joinPath(request.configurationRoot, CONFIGURATION_FILE_NAME);
      return file.ok
        ? ok(file.value)
        : filesystemOutcome(file.error.code, request.configurationRoot);
    }
    case "project": {
      if (request.workspaceRoot === null) {
        return err({ kind: "workspace-required" });
      }
      const file = joinPath(
        request.workspaceRoot,
        PROJECT_CONFIGURATION_DIRECTORY,
        CONFIGURATION_FILE_NAME,
      );
      return file.ok ? ok(file.value) : filesystemOutcome(file.error.code, request.workspaceRoot);
    }
    case "profile": {
      if (request.profile === null) {
        return err({ kind: "profile-required" });
      }
      if (!isLegalProfileName(request.profile)) {
        return err({
          kind: "rejected",
          issues: [
            {
              kind: "invalid-value",
              severity: "error",
              path: "profile",
              allowed: [],
            },
          ],
        });
      }
      const file = joinPath(
        request.configurationRoot,
        PROFILE_DIRECTORY,
        `${request.profile}.jsonc`,
      );
      return file.ok
        ? ok(file.value)
        : filesystemOutcome(file.error.code, request.configurationRoot);
    }
  }
}

export async function writeConfigurationKey(
  registry: ConfigurationRegistryPort,
  fileSystem: FileSystemPort,
  request: ConfigurationWriteRequest,
  signal?: AbortSignal,
): Promise<ConfigurationWriteOutcome> {
  if (signal?.aborted === true) {
    return { kind: "cancelled" };
  }

  if (request.operation === "remove") {
    if (registry.resolve(request.keyPath).kind === "unknown")
      return {
        kind: "rejected",
        issues: [{ kind: "unknown-key", severity: "error", path: request.keyPath }],
      };
    const rooted = await requestForWrite(fileSystem, request, signal);
    if (!rooted.ok) return rooted.error;
    const path = resolveConfigurationFilePath(rooted.value);
    if (!path.ok) return path.error;
    return writeValueAtPath(registry, fileSystem, rooted.value, path.value, undefined, signal);
  }

  const coerced = readOverrideLayer(registry, { [request.keyPath]: request.rawValue });
  if (coerced.issues.some((issue) => issue.severity === "error")) {
    return { kind: "rejected", issues: coerced.issues };
  }
  const value = coerced.values[request.keyPath];
  if (value === undefined) {
    return {
      kind: "rejected",
      issues: [{ kind: "unknown-key", severity: "error", path: request.keyPath }],
    };
  }

  const rooted = await requestForWrite(fileSystem, request, signal);
  if (!rooted.ok) {
    return rooted.error;
  }
  const pathResult = resolveConfigurationFilePath(rooted.value);
  if (!pathResult.ok) {
    return pathResult.error;
  }
  return writeValueAtPath(registry, fileSystem, rooted.value, pathResult.value, value, signal);
}

/**
 * Writes one already-typed value through the same validation and atomic file
 * path as `config set`. Object-shaped product state never passes through argv
 * JSON or a second document writer.
 */
export async function writeConfigurationValue(
  registry: ConfigurationRegistryPort,
  fileSystem: FileSystemPort,
  request: ConfigurationValueWriteRequest,
  signal?: AbortSignal,
): Promise<ConfigurationWriteOutcome> {
  if (signal?.aborted === true) {
    return { kind: "cancelled" };
  }

  if (registry.resolve(request.keyPath).kind === "unknown") {
    return {
      kind: "rejected",
      issues: [{ kind: "unknown-key", severity: "error", path: request.keyPath }],
    };
  }

  const rooted = await requestForWrite(fileSystem, request, signal);
  if (!rooted.ok) {
    return rooted.error;
  }
  const pathResult = resolveConfigurationFilePath(rooted.value);
  if (!pathResult.ok) {
    return pathResult.error;
  }
  return writeValueAtPath(
    registry,
    fileSystem,
    rooted.value,
    pathResult.value,
    request.value,
    signal,
  );
}

async function requestForWrite<T extends Omit<ConfigurationWriteRequest, "rawValue"> & object>(
  fileSystem: FileSystemPort,
  request: T,
  signal?: AbortSignal,
): Promise<Result<T & { readonly publicationRoot?: LocalPath }, ConfigurationWriteOutcome>> {
  if (request.scope === "project") {
    return ok(request);
  }

  const home = await resolveConfigurationHome(
    fileSystem,
    {
      current: request.configurationRoot,
      legacy: request.legacyConfigurationRoot ?? null,
    },
    signal,
  );
  switch (home.kind) {
    case "current":
    case "empty":
    case "legacy":
      return ok({
        ...request,
        configurationRoot: home.root,
        publicationRoot: request.configurationRoot,
      });
    case "conflict":
    case "unavailable":
      return home.kind === "conflict"
        ? err({ kind: "rejected", issues: [configurationHomeIssue(home)] })
        : err({ kind: "filesystem", path: home.path, code: home.code });
    case "cancelled":
      return err({ kind: "cancelled" });
  }
}

async function writeValueAtPath(
  registry: ConfigurationRegistryPort,
  fileSystem: FileSystemPort,
  request: Omit<ConfigurationWriteRequest, "rawValue"> & {
    readonly requireAbsent?: boolean;
    readonly operation?: "remove";
    readonly publicationRoot?: LocalPath;
  },
  path: LocalPath,
  value: ConfigurationValue | undefined,
  signal?: AbortSignal,
): Promise<ConfigurationWriteOutcome> {
  const declaration = registry.resolve(request.keyPath);
  if (declaration.kind === "known" && !declaration.descriptor.scopes.includes(request.scope)) {
    return {
      kind: "rejected",
      issues: [
        {
          kind: "scope-unavailable",
          severity: "error",
          path: request.keyPath,
          scope: request.scope,
          availableScopes: declaration.descriptor.scopes,
        },
      ],
    };
  }
  const stated = await fileSystem.stat(path, signal);
  if (!stated.ok) {
    if (stated.error.code === "cancelled") {
      return { kind: "cancelled" };
    }
    return { kind: "filesystem", path, code: stated.error.code };
  }

  if (request.expectedRevision !== undefined) {
    if ((stated.value?.revision ?? null) !== request.expectedRevision) {
      return { kind: "stale-write", path };
    }
  }
  if (stated.value !== null && request.requireAbsent === true) {
    return { kind: "stale-write", path };
  }

  let source: string | null = null;
  if (stated.value !== null) {
    const text = await fileSystem.readBytes(path, MAX_CONFIGURATION_FILE_BYTES, signal);
    if (!text.ok) {
      if (text.error.code === "cancelled") {
        return { kind: "cancelled" };
      }
      return { kind: "filesystem", path, code: text.error.code };
    }
    try {
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(text.value);
    } catch {
      return { kind: "filesystem", path, code: "malformed-encoding" };
    }
  }

  const operations =
    request.operation === "remove"
      ? [{ kind: "remove" as const, path: request.keyPath.split(".") }]
      : [{ kind: "set" as const, path: request.keyPath.split("."), value }];
  const plan = planConfigurationEdits(source, operations);
  if (plan.kind === "rejected") return { kind: "filesystem", path, code: plan.code };
  const scope = SCOPE_BY_FILE[request.scope];
  const validated = registry.validateComplete(plan.document, {
    scope,
    sourceKind: scope === "user" ? "user-file" : scope === "project" ? "project-file" : "profile",
  });
  if (!validated.ok) {
    return { kind: "rejected", issues: validated.issues };
  }
  let composedIssues: readonly ConfigurationIssue[];
  try {
    composedIssues = (await request.validateCandidate?.(path, plan.text, signal)) ?? [];
  } catch {
    return { kind: "filesystem", path, code: "validation-unavailable" };
  }
  if (signal?.aborted === true) return { kind: "cancelled" };
  if (composedIssues.some((issue) => issue.severity === "error"))
    return { kind: "rejected", issues: composedIssues };

  const previousRevision = stated.value?.revision ?? null;
  const bytes = new TextEncoder().encode(plan.text);
  const receipt = {
    previousRevision,
    changedPaths: plan.changedPaths,
    validation: "valid" as const,
    publication: "pending" as const,
    application: "pending" as const,
  };
  const current = await fileSystem.stat(path, signal);
  if (!current.ok)
    return current.error.code === "cancelled"
      ? { kind: "cancelled" }
      : { kind: "filesystem", path, code: current.error.code };
  if ((current.value?.revision ?? null) !== previousRevision) return { kind: "stale-write", path };
  if (source === null && request.operation === "remove") {
    return {
      kind: "unchanged",
      path,
      revision: null,
      byteLength: 0,
      previousRevision: null,
      changedPaths: [],
      validation: "valid",
      save: "unchanged",
      publication: "pending",
      application: "pending",
    };
  }
  if (source === plan.text && previousRevision !== null) {
    return {
      kind: "written",
      path,
      revision: previousRevision,
      byteLength: bytes.byteLength,
      save: "unchanged",
      ...receipt,
    };
  }
  request.onMutationStart?.();
  if (
    request.publicationRoot !== undefined &&
    request.publicationRoot !== request.configurationRoot
  ) {
    const home = await prepareConfigurationHomeForWrite(
      fileSystem,
      { current: request.publicationRoot, legacy: request.configurationRoot },
      signal,
    );
    if (home.kind === "cancelled") return { kind: "cancelled" };
    if (home.kind === "conflict")
      return { kind: "rejected", issues: [configurationHomeIssue(home)] };
    if (home.kind === "unavailable")
      return { kind: "filesystem", path: home.path, code: home.code };
    const destination = resolveConfigurationFilePath({ ...request, configurationRoot: home.root });
    if (!destination.ok) return destination.error;
    path = destination.value;
  }
  const parent = parentPath(path);
  if (parent !== null && stated.value === null) {
    const created = await ensureParentDirectory(fileSystem, parent, signal);
    if (created !== null) return created;
  }
  const written = await fileSystem.writeBytes(path, bytes, signal, {
    expectedRevision: previousRevision,
  });
  if (!written.ok) {
    if (written.error.code === "cancelled") {
      return { kind: "cancelled" };
    }
    if (written.error.code === "stale-write") return { kind: "stale-write", path };
    return { kind: "filesystem", path, code: written.error.code };
  }

  return {
    kind: "written",
    path,
    revision: written.value.revision,
    byteLength: written.value.byteLength,
    save: "saved",
    ...receipt,
  };
}

/** Paths configuration discovery would read for one load request. */
export function configurationSourcePaths(
  configurationRoot: LocalPath,
  workspaceRoot: LocalPath | null,
  profile: string | null,
): readonly LocalPath[] {
  const discovery = discoverSources({ configurationRoot, workspaceRoot, profile });
  return discovery.sources.map((source) => source.file);
}

async function ensureParentDirectory(
  fileSystem: FileSystemPort,
  directory: LocalPath,
  signal?: AbortSignal,
): Promise<ConfigurationWriteOutcome | null> {
  const created = await fileSystem.createDirectory(directory, 0o700, signal);
  if (!created.ok) {
    if (created.error.code === "cancelled") {
      return { kind: "cancelled" };
    }
    return { kind: "filesystem", path: directory, code: created.error.code };
  }
  return null;
}

function filesystemOutcome(
  code: string,
  path: LocalPath,
): Result<never, ConfigurationWriteOutcome> {
  return err({ kind: "filesystem", path, code });
}
