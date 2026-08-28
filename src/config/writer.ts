/**
 * Validated configuration file writes through {@link FileSystemPort}.
 *
 * A value is coerced and validated against the registry before any byte is
 * written. An invalid candidate refuses the whole file rather than publishing a
 * partial edit. Writes are atomic through `writeBytes` and may carry an
 * expected revision to detect concurrent change.
 */

import {
  type ConfigurationIssue,
  type ConfigurationRegistryPort,
  type ConfigurationScope,
  type ConfigurationValue,
  err,
  type FileSystemPort,
  joinPath,
  type LocalPath,
  ok,
  parentPath,
  type Result,
} from "../domain/index.ts";
import { readOverrideLayer } from "./bridges.ts";
import {
  assignConfigurationValue,
  createEmptyConfigurationDocument,
  parseConfigurationDocument,
  serializeConfigurationDocument,
} from "./document.ts";
import { configurationHomeIssue, prepareConfigurationHomeForWrite } from "./home.ts";
import { MAX_CONFIGURATION_FILE_BYTES } from "./jsonc.ts";
import { CONFIGURATION_SCHEMA_VERSION, SCHEMA_VERSION_FIELD } from "./schema-family.ts";
import {
  CONFIGURATION_FILE_NAME,
  discoverSources,
  isLegalProfileName,
  PROFILE_DIRECTORY,
  PROJECT_CONFIGURATION_DIRECTORY,
} from "./sources.ts";

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
  /** When set, the file must still have this revision or the write is refused. */
  readonly expectedRevision?: string | null;
};

/** A typed value write used by product-owned configuration actions. */
export type ConfigurationValueWriteRequest = Omit<ConfigurationWriteRequest, "rawValue"> & {
  readonly value: ConfigurationValue;
  /** Refuse when a file appeared after the caller observed it absent. */
  readonly requireAbsent?: boolean;
};

export type ConfigurationWriteOutcome =
  | {
      readonly kind: "written";
      readonly path: LocalPath;
      readonly revision: string;
      readonly byteLength: number;
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
): Promise<Result<T, ConfigurationWriteOutcome>> {
  if (request.scope === "project") {
    return ok(request);
  }

  const home = await prepareConfigurationHomeForWrite(
    fileSystem,
    {
      current: request.configurationRoot,
      legacy: request.legacyConfigurationRoot ?? null,
    },
    signal,
  );
  switch (home.kind) {
    case "ready":
      return ok({ ...request, configurationRoot: home.root });
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
  request: Omit<ConfigurationWriteRequest, "rawValue"> & { readonly requireAbsent?: boolean },
  path: LocalPath,
  value: ConfigurationValue,
  signal?: AbortSignal,
): Promise<ConfigurationWriteOutcome> {
  const stated = await fileSystem.stat(path, signal);
  if (!stated.ok) {
    if (stated.error.code === "cancelled") {
      return { kind: "cancelled" };
    }
    return { kind: "filesystem", path, code: stated.error.code };
  }

  if (
    stated.value !== null &&
    request.expectedRevision !== undefined &&
    request.expectedRevision !== null
  ) {
    if (stated.value.revision !== request.expectedRevision) {
      return { kind: "stale-write", path };
    }
  }
  if (stated.value !== null && request.requireAbsent === true) {
    return { kind: "stale-write", path };
  }

  let document: Record<string, unknown>;
  if (stated.value === null) {
    document = createEmptyConfigurationDocument();
    const parent = parentPath(path);
    if (parent !== null) {
      const created = await ensureParentDirectory(fileSystem, parent, signal);
      if (created !== null) {
        return created;
      }
    }
  } else {
    const text = await fileSystem.readText(path, MAX_CONFIGURATION_FILE_BYTES, signal);
    if (!text.ok) {
      if (text.error.code === "cancelled") {
        return { kind: "cancelled" };
      }
      return { kind: "filesystem", path, code: text.error.code };
    }
    const parsed = parseConfigurationDocument(text.value);
    document =
      parsed === null
        ? createEmptyConfigurationDocument()
        : {
            ...createEmptyConfigurationDocument(),
            ...parsed,
            [SCHEMA_VERSION_FIELD]: parsed[SCHEMA_VERSION_FIELD] ?? CONFIGURATION_SCHEMA_VERSION,
          };
  }

  const candidate = assignConfigurationValue(document, request.keyPath, value);
  const scope = SCOPE_BY_FILE[request.scope];
  const validated = registry.validateComplete(candidate, {
    scope,
    sourceKind: scope === "user" ? "user-file" : scope === "project" ? "project-file" : "profile",
  });
  if (!validated.ok) {
    return { kind: "rejected", issues: validated.issues };
  }

  const bytes = new TextEncoder().encode(serializeConfigurationDocument(candidate));
  const written = await fileSystem.writeBytes(path, bytes, signal);
  if (!written.ok) {
    if (written.error.code === "cancelled") {
      return { kind: "cancelled" };
    }
    return { kind: "filesystem", path, code: written.error.code };
  }

  return {
    kind: "written",
    path,
    revision: written.value.revision,
    byteLength: written.value.byteLength,
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
