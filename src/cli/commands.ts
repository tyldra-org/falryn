/**
 * The two commands v0.1 can honestly ship.
 *
 * `config` is first because the configuration area is fully implemented and its
 * precedence is already proven by #8 — so what this exercises is the CLI path,
 * not new service behavior. `doctor` reports what the local-data and storage
 * areas already know.
 *
 * Both are read-only, and that is a contract rather than a habit:
 * `reference/CLI.md` requires diagnostics not to mutate, so `doctor` describes
 * roots without creating them and `config` inspects without publishing a
 * durable generation. Both declare `READ_ONLY_EFFECT`, which is what makes the
 * claim checkable in the result rather than only in this comment.
 *
 * Neither renders anything. Each returns a `CommandResult` and #18/#19 turn it
 * into text.
 */

import { fromConfigurationIssues, fromUnknown } from "../application/index.ts";
import { CONFIGURATION_FILE_NAME, inspectGeneration, PROFILE_DIRECTORY } from "../config/index.ts";
import {
  probeStorage,
  rootChild,
  type StorageProbe,
  sqliteDatabasePath,
  usableRoots,
} from "../data/index.ts";
import {
  type ConfigurationInspection,
  type ConfigurationIssue,
  type FalrynError,
  joinPath,
  LOCAL_DATA_ROOTS,
  type LocalDataRoot,
  type OwnershipClass,
  type RootStatus,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import type { GlobalOptions } from "./options.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandId,
  type CommandResult,
  READ_ONLY_EFFECT,
} from "./result.ts";
import type { ServiceProvider } from "./services.ts";

/** A finished result with the fields every command shares already filled in. */
function resultFor<Payload>(
  command: CommandId,
  payload: Payload | null,
  errors: readonly FalrynError[] = [],
): CommandResult<Payload> {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command,
    outcome: errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" },
    effect: READ_ONLY_EFFECT,
    payload,
    errors,
    warnings: [],
    omissions: [],
    truncation: [],
    correlation: {
      workspaceId: null,
      sessionId: null,
      turnId: null,
      traceId: null,
      scopeId: null,
      invocationId: null,
      capabilityId: null,
      eventId: null,
    },
  };
}

/**
 * A translated issue set as an error list.
 *
 * `fromConfigurationIssues` returns `null` when nothing in the set blocks use,
 * which is a real answer: a load can raise advisory issues and still be valid.
 */
function errorsFrom(error: FalrynError | null): readonly FalrynError[] {
  return error === null ? [] : [error];
}

/* -------------------------------------------------------------------------- */
/* config                                                                      */
/* -------------------------------------------------------------------------- */

export type ConfigShowPayload = {
  readonly inspection: ConfigurationInspection;
  /** Whether any issue the loader raised blocks use of the configuration. */
  readonly usable: boolean;
};

export type ConfigValidatePayload = {
  readonly issues: readonly ConfigurationIssue[];
  readonly valid: boolean;
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
): Promise<CommandResult<ConfigShowPayload>> {
  const { loader, registry, configurationRoot, workspaceRoot } = services();
  const outcome = await loader.load({
    configurationRoot,
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
      return resultFor<ConfigShowPayload>(
        "config.show",
        outcome.retained === null
          ? null
          : { inspection: inspectGeneration(registry, outcome.retained), usable: false },
        errorsFrom(fromConfigurationIssues(outcome.issues, { operation: "load configuration" })),
      );
    default:
      // `unpublished` and `cancelled`: composition worked and publication did
      // not, or the caller stopped. Neither is a valid configuration to show.
      return resultFor<ConfigShowPayload>("config.show", null, [
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
): Promise<CommandResult<ConfigValidatePayload>> {
  const { loader, configurationRoot, workspaceRoot } = services();
  const outcome = await loader.load({
    configurationRoot,
    workspaceRoot,
    profile: options.profile,
    overrides,
  });

  if (outcome.kind === "rejected") {
    return resultFor(
      "config.validate",
      { issues: outcome.issues, valid: false },
      errorsFrom(fromConfigurationIssues(outcome.issues, { operation: "validate configuration" })),
    );
  }
  // A load that published or was unchanged raised no blocking issue; the
  // command still reports success explicitly rather than by saying nothing.
  return resultFor("config.validate", { issues: [], valid: true });
}

/**
 * Names every path configuration is read from, without reading any of them.
 *
 * Deliberately not a load: a reader asking *where* settings come from is
 * usually asking because a load already went wrong, and answering that question
 * must not depend on the load succeeding.
 */
export function runConfigPath(
  services: ServiceProvider,
  options: GlobalOptions,
): CommandResult<ConfigPathPayload> {
  const { configurationRoot, workspaceRoot } = services();
  const sources: { kind: string; path: string }[] = [];

  const userFile = joinPath(configurationRoot, CONFIGURATION_FILE_NAME);
  if (userFile.ok) {
    sources.push({ kind: "user-file", path: userFile.value });
  }
  if (workspaceRoot !== null) {
    const projectFile = joinPath(workspaceRoot, CONFIGURATION_FILE_NAME);
    if (projectFile.ok) {
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

/* -------------------------------------------------------------------------- */
/* doctor                                                                      */
/* -------------------------------------------------------------------------- */

export type DoctorPayload = {
  /** Every declared root, whether it resolved, and whether it is usable. */
  readonly roots: readonly {
    readonly root: LocalDataRoot;
    readonly path: string | null;
    readonly usable: boolean;
    readonly code: string | null;
  }[];
  /** Overrides the layout could not use, with the reason each was rejected. */
  readonly rootIssues: readonly string[];
  /** Where the database would live. Named whether or not one exists. */
  readonly databasePath: string | null;
  /**
   * What the database on disk reports about itself.
   *
   * Read with `create: false`, so asking whether a database exists never
   * creates one. `absent` is a normal answer on a machine that has not run
   * Falryn yet.
   */
  readonly storage: StorageProbe;
  /** Ownership classes with an owner, and those still unregistered. */
  readonly registeredClasses: readonly OwnershipClass[];
  readonly unregisteredClasses: readonly OwnershipClass[];
  readonly build: { readonly platform: string; readonly architecture: string };
};

/**
 * Bounded, read-only environment and storage diagnostics.
 *
 * It reports where each root *would* be and whether it is usable, and it does
 * not call `prepareRoots`: creating a directory as a side effect of describing
 * it is exactly the mutation `reference/CLI.md` forbids diagnostics from doing.
 * The database is named, not opened, for the same reason — opening it creates
 * it.
 */
export async function runDoctor(services: ServiceProvider): Promise<CommandResult<DoctorPayload>> {
  try {
    const { localData } = services();
    const layout = localData.layout;

    const roots = LOCAL_DATA_ROOTS.map((root) => {
      const resolved = layout.roots.find((candidate) => candidate.root === root);
      const path = rootChild(layout, root);
      return {
        root,
        path,
        usable: resolved !== undefined,
        code: resolved === undefined ? "unresolved" : null,
      };
    });

    const stateRoot = rootChild(layout, "state");
    const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
    return resultFor("doctor", {
      roots,
      rootIssues: localData.resolutionIssues.map((issue) => issue.code),
      databasePath,
      storage:
        databasePath === null
          ? { kind: "unreadable", code: "unresolved-path" }
          : await probeStorage({ open: openBunSqlite, databasePath }),
      registeredClasses: localData.registrations().map((entry) => entry.ownershipClass),
      unregisteredClasses: localData.unregistered(),
      build: { platform: process.platform, architecture: process.arch },
    });
  } catch (error) {
    return resultFor<DoctorPayload>("doctor", null, [
      fromUnknown(error, { operation: "collect diagnostics" }),
    ]);
  }
}

/** Whether a root status reports a usable root. Kept for the status form. */
export function usableRootNames(statuses: readonly RootStatus[]): readonly LocalDataRoot[] {
  return usableRoots(statuses);
}
