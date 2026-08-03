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

import {
  fromConfigurationIssues,
  fromUnknown,
  fromUnreadConfigurationSources,
} from "../application/index.ts";
import { CONFIGURATION_FILE_NAME, inspectGeneration, PROFILE_DIRECTORY } from "../config/index.ts";
import { probeStorage, rootChild, type StorageProbe, sqliteDatabasePath } from "../data/index.ts";
import {
  assertNever,
  blocksLocalData,
  type ConfigurationInspection,
  type ConfigurationIssue,
  effectOf,
  type FalrynError,
  isUnreadSource,
  joinPath,
  LOCAL_DATA_ROOTS,
  type LocalDataRoot,
  type LocalPath,
  type OwnershipClass,
  type RootInspection,
  type RootViability,
  type SourceReport,
  type TerminalOutcome,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import type { GlobalOptions } from "./options.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandId,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";
import type { ServiceProvider } from "./services.ts";

/** A finished result with the fields every command shares already filled in. */
function resultFor<Command extends CommandId, Payload>(
  command: Command,
  payload: Payload | null,
  errors: readonly FalrynError[] = [],
  outcome?: TerminalOutcome,
  effect?: CommandEffect,
): CommandResultOf<Command, Payload> {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command,
    // A command whose *finding* is the failure supplies its own outcome: it
    // raised no `FalrynError`, because nothing went wrong with the command —
    // what it diagnosed is what is wrong.
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
    effect: effect ?? READ_ONLY_EFFECT,
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
): Promise<CommandResultOf<"config.show", ConfigShowPayload>> {
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
): Promise<CommandResultOf<"config.validate", ConfigValidatePayload>> {
  const { loader, configurationRoot, workspaceRoot } = services();
  const outcome = await loader.load({
    configurationRoot,
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
 * must not depend on the load succeeding.
 */
export function runConfigPath(
  services: ServiceProvider,
  options: GlobalOptions,
): CommandResultOf<"config.path", ConfigPathPayload> {
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

/**
 * What `doctor` could establish about the database.
 *
 * A superset of `StorageProbe` rather than a change to it. `probeStorage` maps
 * every `cannot-open` to `absent`, which is the right answer for a reachable
 * root and a wrong one for a root that is a regular file — so when the state
 * root cannot hold data, `doctor` reports that it did not determine the answer
 * instead of running a probe whose result it could not trust.
 */
export type DoctorStorage =
  | StorageProbe
  | { readonly kind: "undetermined"; readonly reason: "state-root-not-viable" };

export type DoctorPayload = {
  /**
   * Every declared root, where it would be, and whether it can hold data.
   *
   * `resolved` and `viability` are separate because they answer different
   * questions. `resolved` is whether the layout produced a path at all;
   * `viability` is whether that path can hold data. The field this replaced was
   * called `usable` and measured only the first, which is how a state root that
   * was a regular file was reported as healthy.
   */
  readonly roots: readonly {
    readonly root: LocalDataRoot;
    readonly path: string | null;
    readonly resolved: boolean;
    readonly viability: RootViability;
    readonly code: string | null;
  }[];
  /** Overrides the layout could not use, with the reason each was rejected. */
  readonly rootIssues: readonly string[];
  /** Where the database would live. Named whether or not one exists. */
  readonly databasePath: string | null;
  /** Whether any finding means Falryn cannot hold data here. */
  readonly blocked: boolean;
  /**
   * What the database on disk reports about itself.
   *
   * Read with `create: false`, so asking whether a database exists never
   * creates one. `absent` is a normal answer on a machine that has not run
   * Falryn yet — but only when the state root could actually be reached.
   */
  readonly storage: DoctorStorage;
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
export async function runDoctor(
  services: ServiceProvider,
): Promise<CommandResultOf<"doctor", DoctorPayload>> {
  try {
    const { localData } = services();
    const layout = localData.layout;

    // Read-only throughout: this probes what is there and creates nothing, so
    // a root that does not exist stays a root that does not exist.
    const inspections = await localData.inspectRoots();
    const byRoot = new Map<LocalDataRoot, RootInspection>(
      inspections.map((inspection) => [inspection.root, inspection]),
    );

    const roots = LOCAL_DATA_ROOTS.map((root) => {
      const inspection = byRoot.get(root);
      return {
        root,
        path: rootChild(layout, root),
        // An unresolved root produced no path to inspect, so its viability is
        // genuinely unknown rather than blocked — nothing was probed.
        resolved: inspection !== undefined,
        viability: inspection?.viability ?? ("unknown" as RootViability),
        code: inspection === undefined ? "unresolved" : inspection.code,
      };
    });

    const stateRoot = rootChild(layout, "state");
    const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
    const state = byRoot.get("state");
    const storage = await storageFor(databasePath, state);

    const blocked =
      inspections.some(blocksLocalData) ||
      roots.some((entry) => !entry.resolved) ||
      storage.kind === "unreadable" ||
      storage.kind === "undetermined";

    return resultFor(
      "doctor",
      {
        roots,
        rootIssues: localData.resolutionIssues.map((issue) => issue.code),
        databasePath,
        blocked,
        storage,
        registeredClasses: localData.registrations().map((entry) => entry.ownershipClass),
        unregisteredClasses: localData.unregistered(),
        build: { platform: process.platform, architecture: process.arch },
      },
      [],
      // A blocking finding is the diagnosis, not a failure of the command, so
      // it carries no error — but it must reach the exit status, because
      // `reference/CLI.md` makes the verdict of a diagnostic its exit code and
      // an unconditional `0` leaves that verdict carried by nothing. The effect
      // is `none`: diagnosing changed nothing.
      blocked ? { kind: "failed", effect: "none" } : undefined,
    );
  } catch (error) {
    return resultFor<"doctor", DoctorPayload>("doctor", null, [
      fromUnknown(error, { operation: "collect diagnostics" }),
    ]);
  }
}

/**
 * What the database reports, or why `doctor` did not ask.
 *
 * A state root that cannot hold data would make `probeStorage` report `absent`,
 * because the driver's `cannot-open` covers both "no file yet" and "no path at
 * all". Rather than teach the probe a distinction it has no way to draw, the
 * command declines to run it and says so.
 */
async function storageFor(
  databasePath: LocalPath | null,
  state: RootInspection | undefined,
): Promise<DoctorStorage> {
  if (databasePath === null) {
    return { kind: "unreadable", code: "unresolved-path" };
  }
  if (state !== undefined && blocksLocalData(state)) {
    return { kind: "undetermined", reason: "state-root-not-viable" };
  }
  return probeStorage({ open: openBunSqlite, databasePath });
}

/* -------------------------------------------------------------------------- */
/* A command that did not finish                                               */
/* -------------------------------------------------------------------------- */

/**
 * The result of an invocation that stopped before its command answered.
 *
 * An interrupt or an expired deadline ends the *invocation*, and the command it
 * was running is left where it was. There is no payload, because there is no
 * answer — and one is still emitted, in the format the caller asked for, so a
 * reader waiting on a terminal record gets one rather than a stream that stops.
 *
 * It carries no `FalrynError`: nothing went wrong with the command. The outcome
 * came from the scope that stopped, and the exit table reads it directly.
 */
export function stoppedResult(
  command: Exclude<CommandId, "default" | "help" | "version">,
  outcome: TerminalOutcome,
): RunCommandResult {
  // What the scope observed, not what the command declared. Every v0.1 command
  // intends nothing, and an invocation stopped after it had begun changing
  // something still has to say that it may have — which is the fact the exit
  // table reads before it reads the outcome.
  const effect: CommandEffect = { intent: "none", observed: effectOf(outcome) };

  switch (command) {
    case "config.show":
      return resultFor<"config.show", ConfigShowPayload>("config.show", null, [], outcome, effect);
    case "config.validate":
      return resultFor<"config.validate", ConfigValidatePayload>(
        "config.validate",
        null,
        [],
        outcome,
        effect,
      );
    case "config.path":
      return resultFor<"config.path", ConfigPathPayload>("config.path", null, [], outcome, effect);
    case "doctor":
      return resultFor<"doctor", DoctorPayload>("doctor", null, [], outcome, effect);
    default:
      // A command added without a branch fails to compile here rather than
      // reporting a stopped run under someone else's command identity.
      return assertNever(command, "unhandled command");
  }
}

/* -------------------------------------------------------------------------- */
/* The result surface a projection renders                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every result a command that does work can produce.
 *
 * Discriminated by `command`, so a projection switching on it reads the payload
 * that command actually declared instead of an `unknown` it has to re-check at
 * runtime. `default`, `help`, and `version` are absent because they answer with
 * text rather than a result — dispatch resolves them before any command runs.
 */
export type RunCommandResult =
  | Awaited<ReturnType<typeof runConfigShow>>
  | Awaited<ReturnType<typeof runConfigValidate>>
  | ReturnType<typeof runConfigPath>
  | Awaited<ReturnType<typeof runDoctor>>;
