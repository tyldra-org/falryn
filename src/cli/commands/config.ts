/** Configuration inspection, validation, path, and mutation commands. */

import {
  adoptForeignError,
  fromConfigurationIssues,
  fromUnknown,
  fromUnreadConfigurationSources,
} from "../../application/index.ts";
import {
  CONFIGURATION_FILE_NAME,
  type ConfigurationFileScope,
  configurationHomeIssue,
  inspectGeneration,
  PROFILE_DIRECTORY,
  PROJECT_CONFIGURATION_DIRECTORY,
  writeConfigurationKey,
} from "../../config/index.ts";
import {
  type ConfigurationInspection,
  type ConfigurationIssue,
  isUnreadSource,
  joinPath,
  type SourceReport,
} from "../../domain/index.ts";
import type { ConfigSetArguments } from "../command-tree.ts";
import type { GlobalOptions } from "../options.ts";
import type { CommandResultOf } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import {
  errorsFrom,
  MUTATION_NOT_OBSERVED,
  resultFor,
  WRITE_COMPLETED_EFFECT,
  workspaceResolveError,
} from "./shared.ts";

export type ConfigShowPayload = {
  readonly inspection: ConfigurationInspection;
  /** Whether any issue the loader raised blocks use of the configuration. */
  readonly usable: boolean;
};

export type ConfigValidatePayload = {
  readonly issues: readonly ConfigurationIssue[];
  /**
   * Whether any issue blocks use of the configuration that loaded.
   *
   * Deliberately unchanged in meaning. Whether every declared source was
   * actually read is a second question, and folding it in here would leave a
   * reader unable to tell a document with a mistyped key from a document
   * nobody could open. {@link ConfigValidatePayload.unreadSources} answers it.
   */
  readonly valid: boolean;
  /**
   * Sources that exist and were skipped, exactly as the loader reported them.
   *
   * The loader fails open on an unavailable source, so these values loaded
   * without the file the user edited. Carried rather than re-derived: nothing
   * here re-reads a path or writes a second precedence rule.
   */
  readonly unreadSources: readonly SourceReport[];
};

export type ConfigPathPayload = {
  /** Every place configuration is read from, in precedence order. */
  readonly sources: readonly { readonly kind: string; readonly path: string }[];
};

/**
 * Loads configuration and reports what it found.
 *
 * The load is the existing one: the same six layers, the same precedence, the
 * same issue vocabulary. This maps `--verbose`/`--quiet` onto the declared key
 * they override and hands the map to the loader — it writes no precedence rule
 * of its own.
 */
export async function runConfigShow(
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  options: GlobalOptions,
  signal?: AbortSignal,
): Promise<CommandResultOf<"config.show", ConfigShowPayload>> {
  const workspace = await services().ensureWorkspaceSet(signal);
  if (!workspace.ok) {
    return resultFor<"config.show", ConfigShowPayload>("config.show", null, [
      workspaceResolveError(workspace.error),
    ]);
  }
  const { loader, registry, configurationRoot, legacyConfigurationRoot, workspaceRoot } =
    services();
  const outcome = await loader.load({
    configurationRoot,
    legacyConfigurationRoot,
    workspaceRoot,
    profile: options.profile,
    overrides,
  });

  switch (outcome.kind) {
    case "published":
    case "unchanged":
      return resultFor("config.show", {
        // Rendered through each key's declared sensitivity by the registry's
        // own redactor. No secret reaches this payload, because the
        // inspection projection never carries one.
        inspection: inspectGeneration(registry, outcome.record),
        usable: true,
      });
    case "rejected":
      return resultFor<"config.show", ConfigShowPayload>(
        "config.show",
        outcome.retained === null
          ? null
          : { inspection: inspectGeneration(registry, outcome.retained), usable: false },
        errorsFrom(fromConfigurationIssues(outcome.issues, { operation: "load configuration" })),
      );
    default:
      // `unpublished` and `cancelled`: composition worked and publication did
      // not, or the caller stopped. Neither is a valid configuration to show.
      return resultFor<"config.show", ConfigShowPayload>("config.show", null, [
        fromUnknown(new Error(`configuration could not be loaded: ${outcome.kind}`), {
          operation: "load configuration",
        }),
      ]);
  }
}

/** Reports every issue the loader raised, and whether any of them blocks use. */
export async function runConfigValidate(
  services: ServiceProvider,
  overrides: Readonly<Record<string, string>>,
  options: GlobalOptions,
  signal?: AbortSignal,
): Promise<CommandResultOf<"config.validate", ConfigValidatePayload>> {
  const workspace = await services().ensureWorkspaceSet(signal);
  if (!workspace.ok) {
    return resultFor<"config.validate", ConfigValidatePayload>("config.validate", null, [
      workspaceResolveError(workspace.error),
    ]);
  }
  const { loader, configurationRoot, legacyConfigurationRoot, workspaceRoot } = services();
  const outcome = await loader.load({
    configurationRoot,
    legacyConfigurationRoot,
    workspaceRoot,
    profile: options.profile,
    overrides,
  });

  if (outcome.kind === "rejected") {
    // The refusal is the verdict and keeps its own exit status. The unread
    // sources still travel with it: a load can be refused for a bad key *and*
    // have skipped a file, and reporting only the first hides the second.
    return resultFor(
      "config.validate",
      {
        issues: outcome.issues,
        valid: false,
        unreadSources: outcome.sources.filter(isUnreadSource),
      },
      errorsFrom(fromConfigurationIssues(outcome.issues, { operation: "validate configuration" })),
    );
  }

  const record =
    outcome.kind === "published" || outcome.kind === "unchanged" ? outcome.record : null;
  const unreadSources = (record?.sources ?? []).filter(isUnreadSource);

  // A load that published or was unchanged raised no blocking issue, so what
  // loaded is valid. Whether it is what the user *wrote* is the other question:
  // a file that exists and could not be read means these values are not the
  // authored ones, which is a blocking verdict for the command that exists to
  // answer exactly that.
  return resultFor(
    "config.validate",
    { issues: [], valid: true, unreadSources },
    errorsFrom(
      fromUnreadConfigurationSources(unreadSources, { operation: "validate configuration" }),
    ),
  );
}

/**
 * Names every path configuration is read from, without reading any of them.
 *
 * Deliberately not a load: a reader asking *where* settings come from is
 * usually asking because a load already went wrong, and answering that question
 * must not depend on the load succeeding. It does resolve `--workspace` so a
 * saved layout name still names the project file under the primary root.
 */
export async function runConfigPath(
  services: ServiceProvider,
  options: GlobalOptions,
  signal?: AbortSignal,
): Promise<CommandResultOf<"config.path", ConfigPathPayload>> {
  const workspace = await services().ensureWorkspaceSet(signal);
  if (!workspace.ok) {
    return resultFor<"config.path", ConfigPathPayload>("config.path", null, [
      workspaceResolveError(workspace.error),
    ]);
  }
  const graph = services();
  const { workspaceRoot } = graph;
  const home = await graph.configurationHomeForRead(signal);
  if (home.kind === "cancelled") {
    return resultFor<"config.path", ConfigPathPayload>("config.path", null, [], {
      kind: "cancelled",
      effect: "none",
    });
  }
  if (home.kind === "conflict" || home.kind === "unavailable") {
    return resultFor<"config.path", ConfigPathPayload>(
      "config.path",
      null,
      errorsFrom(
        fromConfigurationIssues([configurationHomeIssue(home)], {
          operation: "resolve configuration path",
        }),
      ),
    );
  }
  const configurationRoot = home.root;
  const sources: { kind: string; path: string }[] = [];

  const userFile = joinPath(configurationRoot, CONFIGURATION_FILE_NAME);
  if (userFile.ok) {
    sources.push({ kind: "user-file", path: userFile.value });
  }
  if (workspaceRoot !== null) {
    const projectFile = joinPath(
      workspaceRoot,
      PROJECT_CONFIGURATION_DIRECTORY,
      CONFIGURATION_FILE_NAME,
    );
    if (projectFile.ok && (!userFile.ok || projectFile.value !== userFile.value)) {
      sources.push({ kind: "project-file", path: projectFile.value });
    }
  }
  if (options.profile !== null) {
    const profileFile = joinPath(configurationRoot, PROFILE_DIRECTORY, `${options.profile}.jsonc`);
    if (profileFile.ok) {
      sources.push({ kind: "profile", path: profileFile.value });
    }
  }

  return resultFor("config.path", { sources });
}

export type ConfigSetPayload = {
  readonly path: string;
  readonly revision: string;
  readonly byteLength: number;
  readonly scope: ConfigurationFileScope;
  readonly keyPath: string;
};

/**
 * Validates and writes one declared key to a scoped configuration file.
 *
 * The value is coerced through the same bridge the CLI override layer uses, and
 * the candidate document is validated before any byte is written.
 */
export async function runConfigSet(
  services: ServiceProvider,
  arguments_: ConfigSetArguments,
  options: GlobalOptions,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"config.set", ConfigSetPayload>> {
  const workspace = await services().ensureWorkspaceSet(signal);
  if (!workspace.ok) {
    return resultFor<"config.set", ConfigSetPayload>("config.set", null, [
      workspaceResolveError(workspace.error),
    ]);
  }
  const { registry, fileSystem, configurationRoot, legacyConfigurationRoot, workspaceRoot } =
    services();
  onMutationStart?.();
  const outcome = await writeConfigurationKey(
    registry,
    fileSystem,
    {
      configurationRoot,
      legacyConfigurationRoot,
      workspaceRoot,
      profile: options.profile,
      scope: arguments_.scope,
      keyPath: arguments_.keyPath,
      rawValue: arguments_.rawValue,
      expectedRevision: arguments_.expectedRevision,
    },
    signal,
  );

  switch (outcome.kind) {
    case "written":
      return resultFor(
        "config.set",
        {
          path: String(outcome.path),
          revision: outcome.revision,
          byteLength: outcome.byteLength,
          scope: arguments_.scope,
          keyPath: arguments_.keyPath,
        },
        [],
        undefined,
        WRITE_COMPLETED_EFFECT,
      );
    case "rejected":
      return resultFor(
        "config.set",
        null,
        errorsFrom(fromConfigurationIssues(outcome.issues, { operation: "write configuration" })),
        undefined,
        MUTATION_NOT_OBSERVED,
      );
    case "stale-write":
      return resultFor(
        "config.set",
        null,
        [
          adoptForeignError(
            {
              code: "configuration.stale-write",
              category: "configuration",
              message: "The configuration file changed before the write could be applied.",
            },
            { operation: "write configuration" },
          ),
        ],
        undefined,
        MUTATION_NOT_OBSERVED,
      );
    case "workspace-required":
      return resultFor(
        "config.set",
        null,
        [
          adoptForeignError(
            {
              code: "configuration.workspace-required",
              category: "configuration",
              message: "Project configuration requires a workspace.",
            },
            { operation: "write configuration" },
          ),
        ],
        undefined,
        MUTATION_NOT_OBSERVED,
      );
    case "profile-required":
      return resultFor(
        "config.set",
        null,
        [
          adoptForeignError(
            {
              code: "configuration.profile-required",
              category: "configuration",
              message: "Profile configuration requires --profile.",
            },
            { operation: "write configuration" },
          ),
        ],
        undefined,
        MUTATION_NOT_OBSERVED,
      );
    case "filesystem":
      return resultFor(
        "config.set",
        null,
        [
          fromUnknown(new Error(`could not write configuration (${outcome.code})`), {
            operation: "write configuration",
          }),
        ],
        undefined,
        MUTATION_NOT_OBSERVED,
      );
    case "cancelled":
      return resultFor<"config.set", ConfigSetPayload>(
        "config.set",
        null,
        [],
        { kind: "cancelled", effect: "none" },
        MUTATION_NOT_OBSERVED,
      );
    default:
      return resultFor("config.set", null, [
        fromUnknown(new Error("configuration write failed"), { operation: "write configuration" }),
      ]);
  }
}

/* -------------------------------------------------------------------------- */
/* doctor                                                                      */
/* -------------------------------------------------------------------------- */
