/**
 * Where each root lives, and what preparing it found.
 *
 * Roots resolve from platform conventions and explicit environment overrides,
 * and from nothing else. In particular they do not resolve from configuration:
 * configuration discovery has to find its root before it can read a key, so a
 * key that moved that root could only ever be read from the place it was
 * trying to leave. That rule is what lets configuration composition start from
 * a root that already exists, and it is why this area depends on no
 * configuration owner.
 *
 * Preparation creates the smallest required set with private permissions and
 * reports anything else. It never widens permissions, never replaces a file
 * with a directory, and never deletes to make room — each of those destroys the
 * evidence that something else is using the path.
 */

import {
  type EnvironmentPort,
  type FileSystemPort,
  isRootUsable,
  joinPath,
  LOCAL_DATA_ROOTS,
  type LocalDataPlatform,
  type LocalDataRoot,
  type LocalPath,
  localPath,
  parseLocalPath,
  type ResolvedRoot,
  type RootLayout,
  type RootStatus,
} from "../domain/index.ts";

/**
 * Permission bits every root is created with.
 *
 * Owner-only. These directories hold a user's whole working history, and a
 * group-readable default on a shared machine is a disclosure that nobody would
 * choose deliberately.
 */
export const PRIVATE_DIRECTORY_MODE = 0o700;

/** The bits that must not be set on an existing root. */
const GROUP_AND_OTHER_BITS = 0o077;

/** The variable that overrides each root. */
export const ROOT_ENVIRONMENT_VARIABLES: Readonly<Record<LocalDataRoot, string>> = {
  configuration: "FALRYN_CONFIG_DIR",
  state: "FALRYN_STATE_DIR",
  cache: "FALRYN_CACHE_DIR",
  logs: "FALRYN_LOG_DIR",
  temporaryIngest: "FALRYN_TEMP_DIR",
  artifacts: "FALRYN_ARTIFACT_DIR",
  exports: "FALRYN_EXPORT_DIR",
};

/**
 * The one platform whose layout has been verified on the actual target.
 *
 * The others are declared so the layout is not macOS-shaped by accident, and
 * are marked unqualified rather than quietly presented as supported.
 */
export const QUALIFIED_PLATFORM: LocalDataPlatform = "darwin";

const APPLICATION_DIRECTORY = "Falryn";

export type PlatformInputs = {
  readonly platform: LocalDataPlatform;
  /** The user's home directory. */
  readonly home: LocalPath;
  readonly environment: EnvironmentPort;
};

function defaultRoots(inputs: PlatformInputs): Readonly<Record<LocalDataRoot, string>> {
  const { home, environment } = inputs;
  switch (inputs.platform) {
    case "darwin": {
      const support = `${home}/Library/Application Support/${APPLICATION_DIRECTORY}`;
      const caches = `${home}/Library/Caches/${APPLICATION_DIRECTORY}`;
      return {
        configuration: `${support}/config`,
        state: `${support}/state`,
        cache: caches,
        logs: `${home}/Library/Logs/${APPLICATION_DIRECTORY}`,
        temporaryIngest: `${caches}/tmp`,
        artifacts: `${support}/artifacts`,
        exports: `${support}/exports`,
      };
    }
    case "linux": {
      // XDG variables are part of the platform convention, not a Falryn
      // override, so they are read here rather than in the override pass.
      const config = environment.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
      const state = environment.get("XDG_STATE_HOME") ?? `${home}/.local/state`;
      const cache = environment.get("XDG_CACHE_HOME") ?? `${home}/.cache`;
      const data = environment.get("XDG_DATA_HOME") ?? `${home}/.local/share`;
      return {
        configuration: `${config}/falryn`,
        state: `${state}/falryn`,
        cache: `${cache}/falryn`,
        logs: `${state}/falryn/logs`,
        temporaryIngest: `${cache}/falryn/tmp`,
        artifacts: `${data}/falryn/artifacts`,
        exports: `${data}/falryn/exports`,
      };
    }
    case "win32": {
      const roaming = environment.get("APPDATA") ?? `${home}/AppData/Roaming`;
      const local = environment.get("LOCALAPPDATA") ?? `${home}/AppData/Local`;
      return {
        configuration: `${roaming}/${APPLICATION_DIRECTORY}/config`,
        state: `${local}/${APPLICATION_DIRECTORY}/state`,
        cache: `${local}/${APPLICATION_DIRECTORY}/cache`,
        logs: `${local}/${APPLICATION_DIRECTORY}/logs`,
        temporaryIngest: `${local}/${APPLICATION_DIRECTORY}/tmp`,
        artifacts: `${local}/${APPLICATION_DIRECTORY}/artifacts`,
        exports: `${local}/${APPLICATION_DIRECTORY}/exports`,
      };
    }
  }
}

export type RootResolutionIssue = {
  readonly root: LocalDataRoot;
  readonly source: "environment-override" | "platform-default";
  readonly variable: string;
  readonly code: string;
};

export type RootResolution = {
  readonly layout: RootLayout;
  /**
   * Overrides that could not be used, with the reason.
   *
   * A rejected override falls back to the platform default rather than failing
   * the whole resolution — but it is reported, because a user who set a
   * variable and saw it ignored deserves to know which one and why.
   */
  readonly issues: readonly RootResolutionIssue[];
};

/** Resolves every root from platform conventions and environment overrides. */
export function resolveRoots(inputs: PlatformInputs): RootResolution {
  const defaults = defaultRoots(inputs);
  const roots: ResolvedRoot[] = [];
  const issues: RootResolutionIssue[] = [];

  for (const root of LOCAL_DATA_ROOTS) {
    const variable = ROOT_ENVIRONMENT_VARIABLES[root];
    const override = inputs.environment.get(variable);

    if (override !== null) {
      const parsed = parseLocalPath(override);
      if (parsed.ok) {
        roots.push({
          root,
          path: parsed.value,
          provenance: "environment-override",
          environmentVariable: variable,
        });
        continue;
      }
      issues.push({
        root,
        source: "environment-override",
        variable,
        code: parsed.error.code,
      });
    }

    const fallback = parseLocalPath(defaults[root]);
    if (!fallback.ok) {
      issues.push({
        root,
        source: "platform-default",
        variable,
        code: fallback.error.code,
      });
      continue;
    }
    roots.push({
      root,
      path: fallback.value,
      provenance: "platform-default",
      environmentVariable: variable,
    });
  }

  return {
    layout: {
      platform: inputs.platform,
      qualified: inputs.platform === QUALIFIED_PLATFORM,
      roots,
    },
    issues,
  };
}

/**
 * Creates the requested roots and describes what it found.
 *
 * "Smallest required set" is the caller's list, not every declared root: a run
 * that never writes an artifact has no reason to create an artifacts directory,
 * and creating one anyway would leave an empty directory that uninstall then
 * has to explain.
 */
export async function prepareRoots(
  fileSystem: FileSystemPort,
  layout: RootLayout,
  required: readonly LocalDataRoot[],
  signal?: AbortSignal,
): Promise<readonly RootStatus[]> {
  const statuses: RootStatus[] = [];
  for (const resolved of layout.roots) {
    if (!required.includes(resolved.root)) {
      continue;
    }
    statuses.push(await prepareOneRoot(fileSystem, resolved, signal));
  }
  return statuses;
}

async function prepareOneRoot(
  fileSystem: FileSystemPort,
  resolved: ResolvedRoot,
  signal?: AbortSignal,
): Promise<RootStatus> {
  const base = {
    root: resolved.root,
    path: resolved.path,
    expectedMode: PRIVATE_DIRECTORY_MODE,
  };

  const existing = await fileSystem.stat(resolved.path, signal);
  if (!existing.ok) {
    return { ...base, code: "unavailable", observedMode: null };
  }

  if (existing.value === null) {
    const created = await fileSystem.createDirectory(resolved.path, PRIVATE_DIRECTORY_MODE, signal);
    if (!created.ok) {
      return {
        ...base,
        code: created.error.code === "not-a-directory" ? "not-a-directory" : "unavailable",
        observedMode: null,
      };
    }
    return {
      ...base,
      code: created.value === "created" ? "created" : "existed",
      observedMode: null,
    };
  }

  if (existing.value.kind !== "directory") {
    return { ...base, code: "not-a-directory", observedMode: existing.value.mode };
  }

  const writable = await fileSystem.probeWritable(resolved.path, signal);
  if (!writable.ok || !writable.value) {
    return { ...base, code: "not-writable", observedMode: existing.value.mode };
  }

  const mode = existing.value.mode;
  // Reported, never repaired: widening or narrowing another process's
  // directory is a decision this code has no standing to make.
  if (mode !== null && (mode & GROUP_AND_OTHER_BITS) !== 0) {
    return { ...base, code: "insecure-permissions", observedMode: mode };
  }

  return { ...base, code: "existed", observedMode: mode };
}

/** The roots that a caller may safely write into. */
export function usableRoots(statuses: readonly RootStatus[]): readonly LocalDataRoot[] {
  return statuses.filter(isRootUsable).map((status) => status.root);
}

/** Resolves a child of a root, refusing any segment that would climb out of it. */
export function rootChild(
  layout: RootLayout,
  root: LocalDataRoot,
  ...segments: readonly string[]
): LocalPath | null {
  const resolved = layout.roots.find((candidate) => candidate.root === root);
  if (resolved === undefined) {
    return null;
  }
  if (segments.length === 0) {
    return resolved.path;
  }
  const joined = joinPath(resolved.path, ...segments);
  return joined.ok ? joined.value : null;
}

/** The default home directory used when a host reports none. */
export const FALLBACK_HOME: LocalPath = localPath("/tmp");
