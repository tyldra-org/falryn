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
  type PathEntry,
  parentPath,
  parseLocalPath,
  type ResolvedRoot,
  type RootInspection,
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
const CONFIGURATION_HOME_DIRECTORY = ".falryn";

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
        configuration: `${home}/${CONFIGURATION_HOME_DIRECTORY}`,
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
      const state = environment.get("XDG_STATE_HOME") ?? `${home}/.local/state`;
      const cache = environment.get("XDG_CACHE_HOME") ?? `${home}/.cache`;
      const data = environment.get("XDG_DATA_HOME") ?? `${home}/.local/share`;
      return {
        configuration: `${home}/${CONFIGURATION_HOME_DIRECTORY}`,
        state: `${state}/falryn`,
        cache: `${cache}/falryn`,
        logs: `${state}/falryn/logs`,
        temporaryIngest: `${cache}/falryn/tmp`,
        artifacts: `${data}/falryn/artifacts`,
        exports: `${data}/falryn/exports`,
      };
    }
    case "win32": {
      const local = environment.get("LOCALAPPDATA") ?? `${home}/AppData/Local`;
      return {
        configuration: `${home}/${CONFIGURATION_HOME_DIRECTORY}`,
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

/** Previous platform-default configuration root, used only for compatibility. */
function legacyConfigurationRoot(inputs: PlatformInputs): string {
  const { home, environment } = inputs;
  switch (inputs.platform) {
    case "darwin":
      return `${home}/Library/Application Support/${APPLICATION_DIRECTORY}/config`;
    case "linux": {
      const config = environment.get("XDG_CONFIG_HOME") ?? `${home}/.config`;
      return `${config}/falryn`;
    }
    case "win32": {
      const roaming = environment.get("APPDATA") ?? `${home}/AppData/Roaming`;
      return `${roaming}/${APPLICATION_DIRECTORY}/config`;
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
      legacyConfigurationRoot: resolveLegacyConfigurationRoot(inputs, roots),
    },
    issues,
  };
}

function resolveLegacyConfigurationRoot(
  inputs: PlatformInputs,
  roots: readonly ResolvedRoot[],
): LocalPath | null {
  const configuration = roots.find((root) => root.root === "configuration");
  if (configuration?.provenance === "environment-override") {
    return null;
  }
  const parsed = parseLocalPath(legacyConfigurationRoot(inputs));
  return parsed.ok ? parsed.value : null;
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

/**
 * Reports whether each root can hold data, and creates nothing.
 *
 * The read-only sibling of {@link prepareRoots}. It runs the same sequence
 * `prepareOneRoot` does — stat, kind, writability, permission bits — with the
 * creation removed and the "it does not exist yet" branch answered by looking
 * at the nearest existing ancestor instead. That is the whole reason it exists:
 * a diagnostic that had to create a directory to find out whether it could is
 * not a diagnostic.
 *
 * It needs no new port. `stat` neither creates nor follows a final symlink,
 * `realPath` resolves one, and `probeWritable` is an access check — so the
 * whole probe is non-mutating with what the boundary already offers.
 */
export async function inspectRoots(
  fileSystem: FileSystemPort,
  layout: RootLayout,
  signal?: AbortSignal,
): Promise<readonly RootInspection[]> {
  const inspections: RootInspection[] = [];
  for (const resolved of layout.roots) {
    inspections.push(await inspectOneRoot(fileSystem, resolved, signal));
  }
  return inspections;
}

async function inspectOneRoot(
  fileSystem: FileSystemPort,
  resolved: ResolvedRoot,
  signal?: AbortSignal,
): Promise<RootInspection> {
  const base = { root: resolved.root, path: resolved.path };

  const existing = await fileSystem.stat(resolved.path, signal);
  if (!existing.ok) {
    // A stat that failed for any reason other than absence has established
    // nothing. Reporting it as healthy is the claim this state exists to avoid.
    return { ...base, viability: "unknown", code: existing.error.code, observedMode: null };
  }

  if (existing.value === null) {
    return inspectAbsent(fileSystem, base, signal);
  }

  // `stat` deliberately does not follow a final symlink, so a root that is a
  // symlink to a real directory would otherwise be judged `not-a-directory`.
  // `prepareOneRoot` has this blind spot today; fixing preparation is a
  // separate outcome, and the divergence is deliberate rather than overlooked.
  if (existing.value.kind === "symlink") {
    return inspectSymlink(fileSystem, base, signal);
  }

  return judgeEntry(fileSystem, base, existing.value, signal);
}

type InspectionBase = { readonly root: LocalDataRoot; readonly path: LocalPath };

/** Whether an existing directory can be written into, and how private it is. */
async function judgeEntry(
  fileSystem: FileSystemPort,
  base: InspectionBase,
  entry: PathEntry,
  signal?: AbortSignal,
): Promise<RootInspection> {
  if (entry.kind !== "directory") {
    return { ...base, viability: "blocked", code: "not-a-directory", observedMode: entry.mode };
  }

  const writable = await fileSystem.probeWritable(entry.path, signal);
  if (!writable.ok) {
    return { ...base, viability: "unknown", code: writable.error.code, observedMode: entry.mode };
  }
  if (!writable.value) {
    return { ...base, viability: "blocked", code: "not-writable", observedMode: entry.mode };
  }

  // Reported on a root that works, never as a reason it does not. Matching
  // `prepareOneRoot`, which warns about the bits rather than repairing them.
  const insecure = entry.mode !== null && (entry.mode & GROUP_AND_OTHER_BITS) !== 0;
  return {
    ...base,
    viability: "ready",
    code: insecure ? "insecure-permissions" : null,
    observedMode: entry.mode,
  };
}

/** A root that is a symlink: the target is what has to hold the data. */
async function inspectSymlink(
  fileSystem: FileSystemPort,
  base: InspectionBase,
  signal?: AbortSignal,
): Promise<RootInspection> {
  const target = await fileSystem.realPath(base.path, signal);
  if (!target.ok) {
    return { ...base, viability: "blocked", code: "dangling-symlink", observedMode: null };
  }

  const entry = await fileSystem.stat(target.value, signal);
  if (!entry.ok) {
    return { ...base, viability: "unknown", code: entry.error.code, observedMode: null };
  }
  if (entry.value === null) {
    return { ...base, viability: "blocked", code: "dangling-symlink", observedMode: null };
  }
  return judgeEntry(fileSystem, base, entry.value, signal);
}

/**
 * A root that is not there yet.
 *
 * Absent is the normal first-run state, but only when something could actually
 * create it — so the nearest existing ancestor decides. A path under a
 * directory nobody may write into will never appear, and calling that `absent`
 * would promise a first run that cannot happen.
 */
async function inspectAbsent(
  fileSystem: FileSystemPort,
  base: InspectionBase,
  signal?: AbortSignal,
): Promise<RootInspection> {
  let candidate = parentPath(base.path);
  while (candidate !== null) {
    const entry = await fileSystem.stat(candidate, signal);
    if (!entry.ok) {
      return { ...base, viability: "unknown", code: entry.error.code, observedMode: null };
    }
    if (entry.value === null) {
      candidate = parentPath(candidate);
      continue;
    }
    if (entry.value.kind !== "directory") {
      // A file where a parent directory has to go. Nothing will create the
      // root beneath it, so this is blocked rather than merely absent.
      return { ...base, viability: "blocked", code: "parent-not-writable", observedMode: null };
    }
    const writable = await fileSystem.probeWritable(candidate, signal);
    if (!writable.ok) {
      return { ...base, viability: "unknown", code: writable.error.code, observedMode: null };
    }
    return writable.value
      ? { ...base, viability: "absent", code: null, observedMode: null }
      : { ...base, viability: "blocked", code: "parent-not-writable", observedMode: null };
  }

  // Every ancestor up to the filesystem root was missing, which no real
  // filesystem reports. It is a state rather than a throw, because a probe
  // racing with another process removing a tree must still return an answer.
  return { ...base, viability: "unknown", code: "not-found", observedMode: null };
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
