/**
 * The command surfaces this build can honestly ship.
 *
 * `config` inspects without publishing a durable generation. `doctor` describes
 * roots without creating them. `data` previews a removal and mutates only when
 * the exact plan identity is confirmed. `export` previews a selection by default
 * and writes a package only with `--write`.
 *
 * None of them render anything. Each returns a `CommandResult` and #18/#19 turn
 * it into text.
 */

import {
  createArtifactReader,
  createDurableArtifactApi,
  createRuntimeRedactor,
  fromArtifactCatalogError,
  fromArtifactError,
  fromArtifactReadError,
  fromConfigurationIssues,
  fromExportError,
  fromRecordError,
  fromRemovalRefusal,
  fromSessionCatalogError,
  fromSessionIsolationError,
  fromSqliteStoreError,
  fromUnknown,
  fromUnreadConfigurationSources,
  inspectWorkspaceSession,
  isolateWorkspaceSessions,
  queryStoredArtifacts,
  queryWorkspaceSessions,
} from "../application/index.ts";
import { CONFIGURATION_FILE_NAME, inspectGeneration, PROFILE_DIRECTORY } from "../config/index.ts";
import {
  createArtifactProvenanceRepository,
  createArtifactRepository,
  createArtifactStore,
  createRecordRepositories,
  createSqliteEventStore,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  probeStorage,
  resolveInventory,
  rootChild,
  type StorageProbe,
  sqliteDatabasePath,
  writePackage,
} from "../data/index.ts";
import {
  type ArtifactApiError,
  type ArtifactCatalogEntry,
  type ArtifactCatalogError,
  type ArtifactError,
  type ArtifactLineage,
  type ArtifactReadError,
  type ArtifactRecord,
  assertNever,
  blocksLocalData,
  type ConfigurationInspection,
  type ConfigurationIssue,
  createInMemoryPackageWriter,
  DEFAULT_BUSY_TIMEOUT_MS,
  type ExportCounts,
  type ExportInventory,
  type ExportOmission,
  type ExportRedaction,
  type ExportSelectionSummary,
  effectOf,
  type FalrynError,
  isRootUsable,
  isUnreadSource,
  joinPath,
  LOCAL_DATA_ROOTS,
  type LocalDataRoot,
  type LocalPath,
  MAX_ARTIFACT_CATALOG,
  MAX_ARTIFACT_RANGE_BYTES,
  MAX_SESSION_CATALOG,
  type OutputStreamPort,
  type OwnershipClass,
  type RecordError,
  type RemovalOutcome,
  type RemovalPlan,
  type Result,
  type RootInspection,
  type RootStatus,
  type RootViability,
  runId,
  type SessionCatalogEntry,
  type SessionCatalogError,
  type SessionIsolationError,
  type SessionIsolationWarning,
  type SourceReport,
  type TerminalOutcome,
} from "../domain/index.ts";
import {
  createHostBlobStore,
  createHostPackageWriter,
  createSha256Hasher,
  openBunSqlite,
} from "../integrations/index.ts";
import type {
  ArtifactCommandArguments,
  DataCommandArguments,
  ExportCommandArguments,
  SessionCommandArguments,
} from "./command-tree.ts";
import type { GlobalOptions } from "./options.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandId,
  type CommandResultOf,
  type CommandTruncation,
  type CommandWarning,
  READ_ONLY_EFFECT,
} from "./result.ts";
import type { ServiceProvider } from "./services.ts";
import { FALRYN_VERSION } from "./version.ts";

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

/** What a data command planned, and whether its exact plan was then applied. */
export type DataRemovalPayload = {
  readonly plan: RemovalPlan;
  readonly execution: RemovalOutcome | null;
  readonly confirmation: "not-requested" | "applied" | "refused";
};

const MUTATION_NOT_OBSERVED: CommandEffect = { intent: "mutate", observed: "none" };

type RemovalCommand = "data.reset" | "data.uninstall";

async function runDataRemoval<Command extends RemovalCommand>(
  command: Command,
  services: ServiceProvider,
  arguments_: DataCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<Command, DataRemovalPayload>> {
  try {
    const localData = services().removalData;
    const plan =
      command === "data.reset"
        ? await localData.planReset({ classes: arguments_.classes }, signal)
        : await localData.planUninstall(signal);

    if (arguments_.confirmation === null) {
      return resultFor(command, { plan, execution: null, confirmation: "not-requested" });
    }

    // The plan was derived in this invocation, after the user saw the prior
    // preview. A changed root, count, or path makes its identity differ before
    // the executor is allowed to start a deletion.
    if (plan.planId !== arguments_.confirmation) {
      return resultFor(
        command,
        { plan, execution: null, confirmation: "refused" },
        [
          fromRemovalRefusal(
            { code: "plan-mismatch", expected: plan.planId, confirmed: arguments_.confirmation },
            { operation: "apply removal plan" },
          ),
        ],
        { kind: "failed", effect: "none" },
        MUTATION_NOT_OBSERVED,
      );
    }
    onMutationStart?.();
    const executed = await localData.executeRemoval(
      plan,
      { planId: arguments_.confirmation },
      signal,
    );
    if (!executed.ok) {
      return resultFor(
        command,
        { plan, execution: null, confirmation: "refused" },
        [fromRemovalRefusal(executed.error, { operation: "apply removal plan" })],
        { kind: "failed", effect: "none" },
        MUTATION_NOT_OBSERVED,
      );
    }

    const outcome: TerminalOutcome | undefined =
      executed.value.effect === "partial"
        ? { kind: "failed", effect: "partial" as const }
        : undefined;
    return resultFor(
      command,
      { plan, execution: executed.value, confirmation: "applied" },
      [],
      outcome,
      { intent: "mutate", observed: executed.value.effect },
    );
  } catch (error) {
    return resultFor(
      command,
      null,
      [fromUnknown(error, { operation: "manage local data" })],
      undefined,
      {
        intent: arguments_.confirmation === null ? "none" : "mutate",
        observed: "uncertain",
      },
    );
  }
}

/** Plans or applies a selective local-data reset. */
export function runDataReset(
  services: ServiceProvider,
  arguments_: DataCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"data.reset", DataRemovalPayload>> {
  return runDataRemoval("data.reset", services, arguments_, signal, onMutationStart);
}

/** Plans or applies the complete registered local-data uninstall. */
export function runDataUninstall(
  services: ServiceProvider,
  arguments_: DataCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"data.uninstall", DataRemovalPayload>> {
  return runDataRemoval("data.uninstall", services, arguments_, signal, onMutationStart);
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
/* export                                                                      */
/* -------------------------------------------------------------------------- */

const WRITE_COMPLETED_EFFECT: CommandEffect = { intent: "mutate", observed: "completed" };

/** What `falryn export` reports: inventory facts and, on write, a bundle handle. */
export type ExportCommandPayload = {
  readonly mode: "preview" | "written";
  readonly selection: ExportSelectionSummary;
  readonly counts: ExportCounts;
  readonly sessionIds: readonly string[];
  readonly artifactBytes: number;
  readonly omissions: readonly ExportOmission[];
  readonly redactions: readonly ExportRedaction[];
  readonly bundle: {
    readonly name: string;
    readonly path: string;
    readonly byteLength: number;
    readonly cancelledAfterFinalize: boolean;
  } | null;
};

/**
 * Preview or write a versioned export package through the owning data pipeline.
 *
 * Selection, bounding, redaction, and package layout stay in `src/data/export.ts`.
 * This command opens storage, asks that pipeline, and returns a handle rather
 * than inlining records.
 */
export async function runExport(
  services: ServiceProvider,
  arguments_: ExportCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"export", ExportCommandPayload>> {
  try {
    return await exportThroughStore(services, arguments_, signal, onMutationStart);
  } catch (error) {
    return resultFor<"export", ExportCommandPayload>(
      "export",
      null,
      [fromUnknown(error, { operation: "export" })],
      undefined,
      arguments_.write ? MUTATION_NOT_OBSERVED : READ_ONLY_EFFECT,
    );
  }
}

async function exportThroughStore(
  services: ServiceProvider,
  arguments_: ExportCommandArguments,
  signal: AbortSignal | undefined,
  onMutationStart: (() => void) | undefined,
): Promise<CommandResultOf<"export", ExportCommandPayload>> {
  const { localData, clock } = services();
  const rootsToPrepare = arguments_.write
    ? (["state", "artifacts", "exports", "temporaryIngest"] as const)
    : (["state", "artifacts", "temporaryIngest"] as const);
  const statuses = await localData.prepareRoots([...rootsToPrepare], signal);
  for (const root of rootsToPrepare) {
    const status = statuses.find((candidate) => candidate.root === root);
    if (status === undefined || !exportRootReady(status)) {
      return resultFor<"export", ExportCommandPayload>(
        "export",
        null,
        [
          fromUnknown(new Error(`the ${root} root is unusable: ${status?.code ?? "unresolved"}`), {
            operation: `prepare ${root} root`,
          }),
        ],
        undefined,
        arguments_.write ? MUTATION_NOT_OBSERVED : READ_ONLY_EFFECT,
      );
    }
  }

  const stateRoot = rootChild(localData.layout, "state");
  const artifactsRoot = rootChild(localData.layout, "artifacts");
  const temporaryRoot = rootChild(localData.layout, "temporaryIngest");
  const exportsRoot = rootChild(localData.layout, "exports");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (
    stateRoot === null ||
    databasePath === null ||
    artifactsRoot === null ||
    temporaryRoot === null ||
    (arguments_.write && exportsRoot === null)
  ) {
    return resultFor<"export", ExportCommandPayload>(
      "export",
      null,
      [
        fromUnknown(new Error("an export root could not be resolved"), {
          operation: "resolve export roots",
        }),
      ],
      undefined,
      arguments_.write ? MUTATION_NOT_OBSERVED : READ_ONLY_EFFECT,
    );
  }

  const opened = await openSqliteStore({
    open: openBunSqlite,
    clock,
    databasePath,
    backupDirectory: stateRoot,
    migrations: PRODUCTION_MIGRATIONS,
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  });
  if (!opened.ok) {
    return resultFor<"export", ExportCommandPayload>(
      "export",
      null,
      [fromSqliteStoreError(opened.error, { operation: "open local database" })],
      undefined,
      arguments_.write ? MUTATION_NOT_OBSERVED : READ_ONLY_EFFECT,
    );
  }

  try {
    const packages = arguments_.write
      ? createHostPackageWriter({ exportsRoot: exportsRoot as LocalPath })
      : createInMemoryPackageWriter();
    const options = {
      store: opened.value,
      repositories: createRecordRepositories(opened.value),
      events: createSqliteEventStore(opened.value),
      blobs: createHostBlobStore({ artifactsRoot, temporaryRoot }),
      packages,
      hasher: createSha256Hasher(),
      clock,
      buildIdentity: `falryn/${FALRYN_VERSION}`,
      redactor: createRuntimeRedactor(),
    };

    const inventory = await resolveInventory(options, arguments_.selection, signal);
    if (!inventory.ok) {
      return exportFailure(arguments_, inventory.error);
    }

    if (!arguments_.write) {
      return resultFor(
        "export",
        payloadFromInventory("preview", arguments_.selection, inventory.value, null),
      );
    }

    const name = arguments_.name;
    if (name === null) {
      return resultFor<"export", ExportCommandPayload>(
        "export",
        null,
        [
          fromUnknown(new Error("export write is missing a package name"), {
            operation: "write export",
          }),
        ],
        undefined,
        MUTATION_NOT_OBSERVED,
      );
    }

    onMutationStart?.();
    const written = await writePackage(
      options,
      name,
      arguments_.selection,
      inventory.value,
      signal,
    );
    if (!written.ok) {
      return exportFailure(arguments_, written.error, MUTATION_NOT_OBSERVED);
    }

    const dest = joinPath(exportsRoot as LocalPath, name);
    const bundle = {
      name,
      path: dest.ok ? dest.value : name,
      byteLength: written.value.byteLength,
      cancelledAfterFinalize: written.value.cancelledAfterFinalize,
    };
    const payload = payloadFromInventory(
      "written",
      arguments_.selection,
      inventory.value,
      bundle,
      written.value.manifest.redactions,
    );
    if (written.value.cancelledAfterFinalize) {
      return resultFor(
        "export",
        payload,
        [],
        { kind: "cancelled", effect: "completed" },
        WRITE_COMPLETED_EFFECT,
      );
    }
    return resultFor("export", payload, [], undefined, WRITE_COMPLETED_EFFECT);
  } finally {
    await opened.value.close(signal);
  }
}

function exportFailure(
  arguments_: ExportCommandArguments,
  error: Parameters<typeof fromExportError>[0],
  effect?: CommandEffect,
): CommandResultOf<"export", ExportCommandPayload> {
  const translated = fromExportError(error, { operation: "export" });
  const cancelled = translated.category === "cancellation";
  return resultFor(
    "export",
    null,
    [translated],
    cancelled ? { kind: "cancelled", effect: "none" } : { kind: "failed", effect: "none" },
    effect ?? (arguments_.write ? MUTATION_NOT_OBSERVED : READ_ONLY_EFFECT),
  );
}

function payloadFromInventory(
  mode: "preview" | "written",
  selection: ExportCommandArguments["selection"],
  inventory: ExportInventory,
  bundle: ExportCommandPayload["bundle"],
  redactions: readonly ExportRedaction[] = [],
): ExportCommandPayload {
  return {
    mode,
    selection: summaryOf(selection, inventory),
    counts: inventory.counts,
    sessionIds: inventory.sessionIds.map((id) => id),
    artifactBytes: inventory.artifactBytes,
    omissions: inventory.omissions,
    redactions,
    bundle,
  };
}

function summaryOf(
  selection: ExportCommandArguments["selection"],
  inventory: ExportInventory,
): ExportSelectionSummary {
  return {
    kind: selection.kind,
    sessions: inventory.sessionIds.length,
    includesSensitive: selection.includeSensitive,
  };
}

/**
 * Whether export may use a prepared root.
 *
 * `insecure-permissions` is still a writable directory: doctor reports it as
 * ready-with-a-warning, and refusing export there would block ordinary host
 * umasks for a diagnostic that does not stop the write.
 */
function exportRootReady(status: RootStatus): boolean {
  return isRootUsable(status) || status.code === "insecure-permissions";
}

/* -------------------------------------------------------------------------- */
/* session                                                                     */
/* -------------------------------------------------------------------------- */

export type SessionListPayload = {
  readonly workspaceId: string;
  readonly filter: string;
  readonly search: string | null;
  readonly sessions: readonly SessionCatalogEntry[];
  readonly omitted: number;
  readonly warnings: readonly SessionIsolationWarning[];
};

export type SessionShowPayload = {
  readonly workspaceId: string;
  readonly session: SessionCatalogEntry;
  readonly warnings: readonly SessionIsolationWarning[];
};

export async function runSessionList(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "list" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"session.list", SessionListPayload>> {
  try {
    return await sessionListThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"session.list", SessionListPayload>("session.list", null, [
      fromUnknown(error, { operation: "list sessions" }),
    ]);
  }
}

export async function runSessionShow(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "show" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"session.show", SessionShowPayload>> {
  try {
    return await sessionShowThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"session.show", SessionShowPayload>("session.show", null, [
      fromUnknown(error, { operation: "show session" }),
    ]);
  }
}

async function sessionListThroughStore(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "list" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"session.list", SessionListPayload>> {
  const opened = await openSessionStore(services, signal);
  if (!opened.ok) {
    return resultFor<"session.list", SessionListPayload>("session.list", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return resultFor("session.list", {
      workspaceId: arguments_.workspaceId,
      filter: arguments_.filter,
      search: arguments_.search ?? null,
      sessions: [],
      omitted: 0,
      warnings: [],
    });
  }

  try {
    const sessions = createRecordRepositories(opened.store).sessions;
    const isolated = isolateWorkspaceSessions(
      sessions,
      {
        bound: {
          workspaceId: arguments_.workspaceId,
          root: services().workspaceRoot ?? null,
          gitIdentity: null,
        },
      },
      signal,
    );
    if (!isolated.ok) {
      return sessionListFailure(isolated.error);
    }
    const catalog = queryWorkspaceSessions(
      sessions,
      {
        workspaceId: arguments_.workspaceId,
        filter: arguments_.filter,
        ...(arguments_.search === undefined ? {} : { search: arguments_.search }),
        limit: arguments_.limit,
      },
      signal,
    );
    if (!catalog.ok) {
      return sessionListFailure(catalog.error);
    }
    const total = catalog.value.sessions.length + catalog.value.omitted;
    const truncation: CommandTruncation[] =
      catalog.value.omitted === 0
        ? []
        : [
            {
              of: "sessions",
              shown: catalog.value.sessions.length,
              total,
              expansion:
                arguments_.limit >= MAX_SESSION_CATALOG ? null : sessionListExpansion(arguments_),
            },
          ];
    return {
      ...resultFor("session.list", {
        workspaceId: arguments_.workspaceId,
        filter: catalog.value.filter,
        search: catalog.value.search,
        sessions: catalog.value.sessions,
        omitted: catalog.value.omitted,
        warnings: isolated.value.warnings,
      }),
      warnings: isolationWarnings(isolated.value.warnings),
      truncation,
      correlation: {
        workspaceId: arguments_.workspaceId,
        sessionId: null,
        turnId: null,
        traceId: null,
        scopeId: null,
        invocationId: null,
        capabilityId: null,
        eventId: null,
      },
    };
  } finally {
    await opened.store.close();
  }
}

async function sessionShowThroughStore(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "show" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"session.show", SessionShowPayload>> {
  const opened = await openSessionStore(services, signal);
  if (!opened.ok) {
    return resultFor<"session.show", SessionShowPayload>("session.show", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return sessionShowFailure({ kind: "session-catalog", code: "not-found", field: "sessionId" });
  }

  try {
    const inspected = inspectWorkspaceSession(
      createRecordRepositories(opened.store).sessions,
      {
        workspaceId: arguments_.workspaceId,
        sessionId: arguments_.sessionId,
        root: services().workspaceRoot ?? null,
        gitIdentity: null,
      },
      signal,
    );
    if (!inspected.ok) {
      return sessionShowFailure(inspected.error);
    }
    return {
      ...resultFor("session.show", {
        workspaceId: arguments_.workspaceId,
        session: inspected.value.entry,
        warnings: inspected.value.warnings,
      }),
      warnings: isolationWarnings(inspected.value.warnings),
      correlation: {
        workspaceId: arguments_.workspaceId,
        sessionId: arguments_.sessionId,
        turnId: null,
        traceId: null,
        scopeId: null,
        invocationId: null,
        capabilityId: null,
        eventId: null,
      },
    };
  } finally {
    await opened.store.close();
  }
}

function sessionListExpansion(
  arguments_: Extract<SessionCommandArguments, { action: "list" }>,
): string {
  const parts = [`falryn session list --limit ${MAX_SESSION_CATALOG}`];
  if (arguments_.filter !== "all") {
    parts.push(`--filter ${arguments_.filter}`);
  }
  if (arguments_.workspaceId !== "cli") {
    parts.push(`--workspace-id ${arguments_.workspaceId}`);
  }
  return parts.join(" ");
}

function isolationWarnings(warnings: readonly SessionIsolationWarning[]): CommandWarning[] {
  return warnings.map((code) => ({
    code,
    message:
      code === "stale-root"
        ? "The bound workspace root no longer matches what this session last observed."
        : "The bound Git identity no longer matches what this session last observed.",
  }));
}

function sessionListFailure(
  error: SessionCatalogError | SessionIsolationError | RecordError,
): CommandResultOf<"session.list", SessionListPayload> {
  return resultFor<"session.list", SessionListPayload>("session.list", null, [
    translateSessionBoundary(error),
  ]);
}

function sessionShowFailure(
  error: SessionCatalogError | SessionIsolationError | RecordError,
): CommandResultOf<"session.show", SessionShowPayload> {
  return resultFor<"session.show", SessionShowPayload>("session.show", null, [
    translateSessionBoundary(error),
  ]);
}

function translateSessionBoundary(
  error: SessionCatalogError | SessionIsolationError | RecordError,
): FalrynError {
  if (error.kind === "record") {
    return fromRecordError(error, { operation: "read sessions" });
  }
  if (error.kind === "session-isolation") {
    return fromSessionIsolationError(error, { operation: "isolate sessions" });
  }
  return fromSessionCatalogError(error, { operation: "read session catalog" });
}

/* -------------------------------------------------------------------------- */
/* artifact                                                                    */
/* -------------------------------------------------------------------------- */

/** Whether stdout carried artifact bytes instead of a rendered result. */
export type ArtifactStdoutDelivery = {
  readonly kind: "stdout-bytes";
};

export type ArtifactListPayload = {
  readonly artifacts: readonly ArtifactCatalogEntry[];
  readonly omitted: number;
};

export type ArtifactShowPayload = {
  readonly lineage: ArtifactLineage;
};

export type ArtifactGetPayload = {
  readonly artifactId: string;
  readonly byteLength: number;
  readonly destination: "stdout" | "file";
  readonly path: string | null;
  readonly bytesWritten: number;
};

export type ArtifactCommandExtras = {
  readonly stdoutDelivery?: ArtifactStdoutDelivery;
};

export async function runArtifactList(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "list" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"artifact.list", ArtifactListPayload>> {
  try {
    return await artifactListThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"artifact.list", ArtifactListPayload>("artifact.list", null, [
      fromUnknown(error, { operation: "list artifacts" }),
    ]);
  }
}

export async function runArtifactShow(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "show" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"artifact.show", ArtifactShowPayload>> {
  try {
    return await artifactShowThroughStore(services, arguments_, signal);
  } catch (error) {
    return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, [
      fromUnknown(error, { operation: "show artifact" }),
    ]);
  }
}

export async function runArtifactGet(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "get" }>,
  options: {
    readonly resultStream: OutputStreamPort;
    readonly stdoutIsTty: boolean;
  },
  signal?: AbortSignal,
): Promise<CommandResultOf<"artifact.get", ArtifactGetPayload> & ArtifactCommandExtras> {
  try {
    return await artifactGetThroughStore(services, arguments_, options, signal);
  } catch (error) {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
      fromUnknown(error, { operation: "get artifact" }),
    ]);
  }
}

async function artifactListThroughStore(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "list" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"artifact.list", ArtifactListPayload>> {
  const opened = await openArtifactStore(services, signal);
  if (!opened.ok) {
    return resultFor<"artifact.list", ArtifactListPayload>("artifact.list", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return resultFor("artifact.list", { artifacts: [], omitted: 0 });
  }

  try {
    const catalog = queryStoredArtifacts(opened.repository, { limit: arguments_.limit }, signal);
    if (!catalog.ok) {
      return artifactListFailure(catalog.error);
    }
    const total = catalog.value.artifacts.length + catalog.value.omitted;
    const truncation: CommandTruncation[] =
      catalog.value.omitted === 0
        ? []
        : [
            {
              of: "artifacts",
              shown: catalog.value.artifacts.length,
              total,
              expansion: arguments_.limit >= MAX_ARTIFACT_CATALOG ? null : artifactListExpansion(),
            },
          ];
    return {
      ...resultFor("artifact.list", {
        artifacts: catalog.value.artifacts,
        omitted: catalog.value.omitted,
      }),
      truncation,
    };
  } finally {
    await opened.store.close();
  }
}

async function artifactShowThroughStore(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "show" }>,
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"artifact.show", ArtifactShowPayload>> {
  const opened = await openArtifactStore(services, signal);
  if (!opened.ok) {
    return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return artifactShowFailure({
      kind: "artifact",
      code: "not-found",
      artifactId: arguments_.artifactId,
    });
  }

  try {
    const api = createDurableArtifactApi({
      artifacts: opened.repository,
      provenance: opened.provenance,
    });
    const described = api.describe(arguments_.artifactId);
    if (!described.ok) {
      return artifactShowFailure(described.error);
    }
    return resultFor("artifact.show", { lineage: described.value });
  } finally {
    await opened.store.close();
  }
}

async function artifactGetThroughStore(
  services: ServiceProvider,
  arguments_: Extract<ArtifactCommandArguments, { action: "get" }>,
  options: {
    readonly resultStream: OutputStreamPort;
    readonly stdoutIsTty: boolean;
  },
  signal: AbortSignal | undefined,
): Promise<CommandResultOf<"artifact.get", ArtifactGetPayload> & ArtifactCommandExtras> {
  const opened = await openArtifactStore(services, signal);
  if (!opened.ok) {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, opened.errors);
  }
  if (opened.kind === "absent") {
    return artifactGetFailure({
      kind: "artifact",
      code: "not-found",
      artifactId: arguments_.artifactId,
    });
  }

  try {
    const found = opened.repository.get(arguments_.artifactId);
    if (!found.ok) {
      return artifactGetFailure(found.error);
    }
    if (found.value === null) {
      return artifactGetFailure({
        kind: "artifact",
        code: "not-found",
        artifactId: arguments_.artifactId,
      });
    }
    const record = found.value;
    if (arguments_.outputPath === null && options.stdoutIsTty) {
      return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
        fromUnknown(new Error("artifact retrieval to a terminal requires --output"), {
          operation: "get artifact",
        }),
      ]);
    }
    const retrievalRefused = refusalForRetrieval(record);
    if (retrievalRefused !== null) {
      return artifactGetFailure(retrievalRefused);
    }
    if (record.availability !== "available") {
      return artifactGetFailure({
        kind: "artifact",
        code: "not-found",
        artifactId: arguments_.artifactId,
      });
    }

    const written =
      arguments_.outputPath === null
        ? await streamArtifactToPort(opened.reader, record, options.resultStream, signal)
        : await streamArtifactToFile(opened.reader, record, arguments_.outputPath, signal);
    if (!written.ok) {
      return artifactGetFailure(written.error);
    }

    const payload: ArtifactGetPayload = {
      artifactId: String(record.artifactId),
      byteLength: record.byteLength,
      destination: arguments_.outputPath === null ? "stdout" : "file",
      path: arguments_.outputPath,
      bytesWritten: written.value,
    };
    const result = resultFor("artifact.get", payload);
    return arguments_.outputPath === null
      ? { ...result, stdoutDelivery: { kind: "stdout-bytes" } }
      : result;
  } finally {
    await opened.store.close();
  }
}

function refusalForRetrieval(record: ArtifactRecord): ArtifactError | null {
  if (record.sensitivity === "restricted") {
    return { kind: "artifact", code: "not-found", artifactId: record.artifactId };
  }
  return null;
}

async function streamArtifactToPort(
  reader: ReturnType<typeof createArtifactReader>,
  record: ArtifactRecord,
  stream: OutputStreamPort,
  signal: AbortSignal | undefined,
): Promise<Result<number, ArtifactError | ArtifactReadError>> {
  let offset = 0;
  let total = 0;
  while (offset < record.byteLength) {
    if (signal?.aborted === true) {
      return {
        ok: false,
        error: { kind: "artifact", code: "cancelled", artifactId: record.artifactId },
      };
    }
    const length = Math.min(MAX_ARTIFACT_RANGE_BYTES, record.byteLength - offset);
    const read = await reader.read(
      { artifactId: record.artifactId, mode: "range", offset, length },
      signal,
    );
    if (!read.ok) {
      return read;
    }
    const bytes = read.value.range?.bytes;
    if (bytes === undefined || bytes === null) {
      return {
        ok: false,
        error: { kind: "artifact", code: "not-found", artifactId: record.artifactId },
      };
    }
    const write = stream.write(bytes);
    if (write.status === "closed") {
      return {
        ok: false,
        error: { kind: "artifact", code: "cancelled", artifactId: record.artifactId },
      };
    }
    total += bytes.byteLength;
    offset += bytes.byteLength;
  }
  return { ok: true, value: total };
}

async function streamArtifactToFile(
  reader: ReturnType<typeof createArtifactReader>,
  record: ArtifactRecord,
  path: string,
  signal: AbortSignal | undefined,
): Promise<Result<number, ArtifactError | ArtifactReadError>> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "w");
  try {
    let offset = 0;
    let total = 0;
    while (offset < record.byteLength) {
      if (signal?.aborted === true) {
        return {
          ok: false,
          error: { kind: "artifact", code: "cancelled", artifactId: record.artifactId },
        };
      }
      const length = Math.min(MAX_ARTIFACT_RANGE_BYTES, record.byteLength - offset);
      const read = await reader.read(
        { artifactId: record.artifactId, mode: "range", offset, length },
        signal,
      );
      if (!read.ok) {
        return read;
      }
      const bytes = read.value.range?.bytes;
      if (bytes === undefined || bytes === null) {
        return {
          ok: false,
          error: { kind: "artifact", code: "not-found", artifactId: record.artifactId },
        };
      }
      await handle.write(bytes);
      total += bytes.byteLength;
      offset += bytes.byteLength;
    }
    return { ok: true, value: total };
  } finally {
    await handle.close();
  }
}

function artifactListExpansion(): string {
  return `falryn artifact list --limit ${MAX_ARTIFACT_CATALOG}`;
}

function artifactListFailure(
  error: ArtifactCatalogError | ArtifactError,
): CommandResultOf<"artifact.list", ArtifactListPayload> {
  return resultFor<"artifact.list", ArtifactListPayload>("artifact.list", null, [
    error.kind === "artifact-catalog"
      ? fromArtifactCatalogError(error, { operation: "list artifacts" })
      : fromArtifactError(error, { operation: "list artifacts" }),
  ]);
}

function artifactShowFailure(
  error: ArtifactError | ArtifactApiError,
): CommandResultOf<"artifact.show", ArtifactShowPayload> {
  if ("kind" in error && error.kind === "artifact") {
    return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, [
      fromArtifactError(error, { operation: "show artifact" }),
    ]);
  }
  return resultFor<"artifact.show", ArtifactShowPayload>("artifact.show", null, [
    fromUnknown(new Error("the artifact could not be described"), { operation: "show artifact" }),
  ]);
}

function artifactGetFailure(
  error: ArtifactError | ArtifactReadError,
): CommandResultOf<"artifact.get", ArtifactGetPayload> {
  if ("kind" in error && error.kind === "artifact") {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
      fromArtifactError(error, { operation: "get artifact" }),
    ]);
  }
  if ("code" in error && error.code === "cancelled") {
    return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
      fromArtifactReadError(error, { operation: "get artifact" }),
    ]);
  }
  return resultFor<"artifact.get", ArtifactGetPayload>("artifact.get", null, [
    fromArtifactReadError(error, { operation: "get artifact" }),
  ]);
}

type ArtifactStore = Extract<Awaited<ReturnType<typeof openSqliteStore>>, { ok: true }>["value"];

type OpenedArtifactStore =
  | { readonly ok: true; readonly kind: "absent" }
  | {
      readonly ok: true;
      readonly kind: "open";
      readonly store: ArtifactStore;
      readonly repository: ReturnType<typeof createArtifactRepository>;
      readonly provenance: ReturnType<typeof createArtifactProvenanceRepository>;
      readonly reader: ReturnType<typeof createArtifactReader>;
    }
  | { readonly ok: false; readonly errors: readonly FalrynError[] };

async function openArtifactStore(
  services: ServiceProvider,
  signal: AbortSignal | undefined,
): Promise<OpenedArtifactStore> {
  const { localData, clock } = services();
  const inspections = await localData.inspectRoots();
  const state = inspections.find((inspection) => inspection.root === "state");
  if (state !== undefined && blocksLocalData(state)) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the state root is unusable"), { operation: "inspect state root" }),
      ],
    };
  }
  const stateRoot = rootChild(localData.layout, "state");
  const artifactsRoot = rootChild(localData.layout, "artifacts");
  const temporaryRoot = rootChild(localData.layout, "temporaryIngest");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (
    stateRoot === null ||
    databasePath === null ||
    artifactsRoot === null ||
    temporaryRoot === null
  ) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("artifact storage roots could not be resolved"), {
          operation: "resolve artifact store",
        }),
      ],
    };
  }
  const probe = await probeStorage({ open: openBunSqlite, databasePath });
  if (probe.kind === "absent") {
    return { ok: true, kind: "absent" };
  }
  if (probe.kind !== "present") {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the local database could not be read"), {
          operation: "probe artifact store",
        }),
      ],
    };
  }
  const opened = await openSqliteStore(
    {
      open: openBunSqlite,
      clock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      create: false,
    },
    signal,
  );
  if (!opened.ok) {
    return {
      ok: false,
      errors: [fromSqliteStoreError(opened.error, { operation: "open local database" })],
    };
  }
  const repository = createArtifactRepository(opened.value, runId.from("cli-artifact-read"));
  const artifactStore = createArtifactStore({
    repository,
    blobs: createHostBlobStore({ artifactsRoot, temporaryRoot }),
    hasher: createSha256Hasher(),
    clock,
  });
  return {
    ok: true,
    kind: "open",
    store: opened.value,
    repository,
    provenance: createArtifactProvenanceRepository(opened.value),
    reader: createArtifactReader(artifactStore),
  };
}

type SessionStore = Extract<Awaited<ReturnType<typeof openSqliteStore>>, { ok: true }>["value"];

type OpenedSessionStore =
  | { readonly ok: true; readonly kind: "absent" }
  | { readonly ok: true; readonly kind: "open"; readonly store: SessionStore }
  | { readonly ok: false; readonly errors: readonly FalrynError[] };

async function openSessionStore(
  services: ServiceProvider,
  signal: AbortSignal | undefined,
): Promise<OpenedSessionStore> {
  const { localData, clock } = services();
  const inspections = await localData.inspectRoots();
  const state = inspections.find((inspection) => inspection.root === "state");
  if (state !== undefined && blocksLocalData(state)) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the state root is unusable"), { operation: "inspect state root" }),
      ],
    };
  }
  const stateRoot = rootChild(localData.layout, "state");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (stateRoot === null || databasePath === null) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("a state root could not be resolved"), {
          operation: "resolve session store",
        }),
      ],
    };
  }
  const probe = await probeStorage({ open: openBunSqlite, databasePath });
  if (probe.kind === "absent") {
    return { ok: true, kind: "absent" };
  }
  if (probe.kind !== "present") {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the local database could not be read"), {
          operation: "probe session store",
        }),
      ],
    };
  }
  const opened = await openSqliteStore(
    {
      open: openBunSqlite,
      clock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      create: false,
    },
    signal,
  );
  if (!opened.ok) {
    return {
      ok: false,
      errors: [fromSqliteStoreError(opened.error, { operation: "open local database" })],
    };
  }
  return { ok: true, kind: "open", store: opened.value };
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
  intent: CommandEffect["intent"] = "none",
): RunCommandResult {
  // The caller supplies the command's declared intent; this records what the
  // scope observed. A preview is still non-mutating when it is interrupted,
  // while a confirmed removal that was interrupted must admit it may have
  // changed data.
  const effect: CommandEffect = { intent, observed: effectOf(outcome) };

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
    case "data.reset":
      return resultFor<"data.reset", DataRemovalPayload>("data.reset", null, [], outcome, effect);
    case "data.uninstall":
      return resultFor<"data.uninstall", DataRemovalPayload>(
        "data.uninstall",
        null,
        [],
        outcome,
        effect,
      );
    case "doctor":
      return resultFor<"doctor", DoctorPayload>("doctor", null, [], outcome, effect);
    case "export":
      return resultFor<"export", ExportCommandPayload>("export", null, [], outcome, effect);
    case "session.list":
      return resultFor<"session.list", SessionListPayload>(
        "session.list",
        null,
        [],
        outcome,
        effect,
      );
    case "session.show":
      return resultFor<"session.show", SessionShowPayload>(
        "session.show",
        null,
        [],
        outcome,
        effect,
      );
    case "artifact.list":
      return resultFor<"artifact.list", ArtifactListPayload>(
        "artifact.list",
        null,
        [],
        outcome,
        effect,
      );
    case "artifact.show":
      return resultFor<"artifact.show", ArtifactShowPayload>(
        "artifact.show",
        null,
        [],
        outcome,
        effect,
      );
    case "artifact.get":
      return resultFor<"artifact.get", ArtifactGetPayload>(
        "artifact.get",
        null,
        [],
        outcome,
        effect,
      );
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
  | Awaited<ReturnType<typeof runDataReset>>
  | Awaited<ReturnType<typeof runDataUninstall>>
  | Awaited<ReturnType<typeof runDoctor>>
  | Awaited<ReturnType<typeof runExport>>
  | Awaited<ReturnType<typeof runSessionList>>
  | Awaited<ReturnType<typeof runSessionShow>>
  | Awaited<ReturnType<typeof runArtifactList>>
  | Awaited<ReturnType<typeof runArtifactShow>>
  | Awaited<ReturnType<typeof runArtifactGet>>;
