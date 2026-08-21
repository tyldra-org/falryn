/**
 * User backup, restore, inspect, and local diagnostics CLI (#724).
 *
 * `falryn data backup|restore|inspect|diagnostics` call the data-layer ports in
 * `src/data/backup.ts`. They are not `falryn doctor`, which reports environment
 * and root viability without opening storage.
 */

import { fromBackupError, fromUnknown } from "../application/index.ts";
import {
  collectLocalDiagnostics,
  createUserBackup,
  inspectUserBackup,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  probeCrashSignals,
  restoreUserBackup,
  rootChild,
  sqliteDatabasePath,
} from "../data/index.ts";
import {
  type BackupName,
  blocksLocalData,
  DEFAULT_BUSY_TIMEOUT_MS,
  type FalrynError,
  isRootUsable,
  type LocalPath,
  type RootStatus,
  type TerminalOutcome,
  userBackupFileName,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import type { DataLifecycleArguments } from "./command-tree.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandId,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";
import type { ServiceProvider } from "./services.ts";

export const DATA_BACKUP_OWNER = "#724";

const WRITE_COMPLETED_EFFECT: CommandEffect = { intent: "mutate", observed: "completed" };
const MUTATION_NOT_OBSERVED: CommandEffect = { intent: "mutate", observed: "none" };

type SessionStore = Extract<Awaited<ReturnType<typeof openSqliteStore>>, { ok: true }>["value"];

export type DataBackupPayload = {
  readonly owner: typeof DATA_BACKUP_OWNER;
  readonly name: string;
  readonly fileName: string;
  readonly schemaVersion: number;
};

export type DataInspectPayload = {
  readonly owner: typeof DATA_BACKUP_OWNER;
  readonly name: string;
  readonly fileName: string;
  readonly schemaVersion: number;
  readonly byteLength: number;
};

export type DataRestorePayload = {
  readonly owner: typeof DATA_BACKUP_OWNER;
  readonly name: string;
  readonly fileName: string;
  readonly schemaVersion: number;
  readonly confirmation: "not-requested" | "applied" | "refused";
  readonly inspection: DataInspectPayload;
};

export type DataDiagnosticsPayload = {
  readonly owner: typeof DATA_BACKUP_OWNER;
  readonly schemaVersion: number;
  readonly crashSignals: {
    readonly writeAheadLogPresent: boolean;
    readonly sharedMemoryPresent: boolean;
  };
  readonly sweep: {
    readonly examined: number;
    readonly deleted: number;
    readonly failed: number;
    readonly completeness: string;
    readonly effect: string;
  } | null;
};

type BackupContext = {
  readonly store: SessionStore;
  readonly stateRoot: LocalPath;
  readonly databasePath: LocalPath;
  readonly crashSignals: Awaited<ReturnType<typeof probeCrashSignals>>;
};

function resultFor<Command extends CommandId, Payload>(
  command: Command,
  payload: Payload | null,
  errors: readonly FalrynError[] = [],
  outcome?: TerminalOutcome,
  effect: CommandEffect = READ_ONLY_EFFECT,
): CommandResultOf<Command, Payload> {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command,
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
    effect,
    payload,
    errors,
    warnings: [],
    omissions: [],
    truncation: [],
    artifacts: [],
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

function backupRootReady(status: RootStatus): boolean {
  return isRootUsable(status) || status.code === "insecure-permissions";
}

function inspectPayload(inspection: {
  readonly name: BackupName;
  readonly schemaVersion: number;
  readonly byteLength: number;
}): DataInspectPayload {
  return {
    owner: DATA_BACKUP_OWNER,
    name: inspection.name,
    fileName: userBackupFileName(inspection.name),
    schemaVersion: inspection.schemaVersion,
    byteLength: inspection.byteLength,
  };
}

function backupFailure<Command extends CommandId, Payload>(
  command: Command,
  error: Parameters<typeof fromBackupError>[0],
  effect?: CommandEffect,
): CommandResultOf<Command, Payload> {
  const translated = fromBackupError(error, { operation: command.replace("data.", "data ") });
  const cancelled = translated.category === "cancellation";
  return resultFor(
    command,
    null,
    [translated],
    cancelled ? { kind: "cancelled", effect: "none" } : { kind: "failed", effect: "none" },
    effect ?? MUTATION_NOT_OBSERVED,
  );
}

async function openBackupContext(
  services: ServiceProvider,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly context: BackupContext }
  | { readonly ok: false; readonly errors: readonly FalrynError[] }
> {
  const { localData, clock, fileSystem } = services();
  const rootsToPrepare = ["state"] as const;
  const statuses = await localData.prepareRoots([...rootsToPrepare], signal);
  for (const root of rootsToPrepare) {
    const status = statuses.find((candidate) => candidate.root === root);
    if (status === undefined || !backupRootReady(status)) {
      return {
        ok: false,
        errors: [
          fromUnknown(new Error(`the ${root} root is unusable: ${status?.code ?? "unresolved"}`), {
            operation: `prepare ${root} root`,
          }),
        ],
      };
    }
  }

  const stateRoot = rootChild(localData.layout, "state");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (stateRoot === null || databasePath === null) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("backup storage roots could not be resolved"), {
          operation: "resolve backup roots",
        }),
      ],
    };
  }

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

  const crashSignals = await probeCrashSignals(fileSystem, stateRoot);

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
      errors: [
        fromUnknown(new Error("the local database could not be opened"), {
          operation: "open local database",
        }),
      ],
    };
  }

  return {
    ok: true,
    context: {
      store: opened.value,
      stateRoot,
      databasePath,
      crashSignals,
    },
  };
}

function backupOptionsFor(context: BackupContext, services: ServiceProvider) {
  const { fileSystem, clock } = services();
  return {
    store: context.store,
    fileSystem,
    backupDirectory: context.stateRoot,
    databasePath: context.databasePath,
    open: openBunSqlite,
    clock,
    migrations: PRODUCTION_MIGRATIONS,
    crashSignals: context.crashSignals,
  };
}

/** Writes a named consistent copy of the live database. */
export async function runDataBackup(
  services: ServiceProvider,
  arguments_: Extract<DataLifecycleArguments, { readonly action: "backup" }>,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"data.backup", DataBackupPayload>> {
  try {
    const opened = await openBackupContext(services, signal);
    if (!opened.ok) {
      return resultFor("data.backup", null, opened.errors, undefined, MUTATION_NOT_OBSERVED);
    }

    onMutationStart?.();
    try {
      const created = createUserBackup(
        backupOptionsFor(opened.context, services),
        arguments_.name,
        signal,
      );
      if (!created.ok) {
        return backupFailure("data.backup", created.error, MUTATION_NOT_OBSERVED);
      }
      return resultFor(
        "data.backup",
        {
          owner: DATA_BACKUP_OWNER,
          name: created.value.name,
          fileName: userBackupFileName(created.value.name),
          schemaVersion: created.value.schemaVersion,
        },
        [],
        undefined,
        WRITE_COMPLETED_EFFECT,
      );
    } finally {
      await opened.context.store.close(signal);
    }
  } catch (error) {
    return resultFor(
      "data.backup",
      null,
      [fromUnknown(error, { operation: "backup local database" })],
      undefined,
      MUTATION_NOT_OBSERVED,
    );
  }
}

/** Inspects a named backup without upgrading it. */
export async function runDataInspect(
  services: ServiceProvider,
  arguments_: Extract<DataLifecycleArguments, { readonly action: "inspect" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"data.inspect", DataInspectPayload>> {
  try {
    const opened = await openBackupContext(services, signal);
    if (!opened.ok) {
      return resultFor("data.inspect", null, opened.errors);
    }

    try {
      const inspected = await inspectUserBackup(
        backupOptionsFor(opened.context, services),
        arguments_.name,
        signal,
      );
      if (!inspected.ok) {
        return backupFailure("data.inspect", inspected.error);
      }
      return resultFor("data.inspect", inspectPayload(inspected.value));
    } finally {
      await opened.context.store.close(signal);
    }
  } catch (error) {
    return resultFor("data.inspect", null, [
      fromUnknown(error, { operation: "inspect local backup" }),
    ]);
  }
}

/** Restores a verified backup after preview or exact confirmation. */
export async function runDataRestore(
  services: ServiceProvider,
  arguments_: Extract<DataLifecycleArguments, { readonly action: "restore" }>,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"data.restore", DataRestorePayload>> {
  try {
    const opened = await openBackupContext(services, signal);
    if (!opened.ok) {
      return resultFor("data.restore", null, opened.errors, undefined, MUTATION_NOT_OBSERVED);
    }

    const options = backupOptionsFor(opened.context, services);
    try {
      const inspected = await inspectUserBackup(options, arguments_.name, signal);
      if (!inspected.ok) {
        return backupFailure("data.restore", inspected.error, MUTATION_NOT_OBSERVED);
      }
      const inspection = inspectPayload(inspected.value);

      if (arguments_.confirmation === null) {
        return resultFor(
          "data.restore",
          {
            owner: DATA_BACKUP_OWNER,
            name: arguments_.name,
            fileName: userBackupFileName(arguments_.name),
            schemaVersion: inspected.value.schemaVersion,
            confirmation: "not-requested",
            inspection,
          },
          [],
          undefined,
          READ_ONLY_EFFECT,
        );
      }

      if (arguments_.confirmation !== arguments_.name) {
        return resultFor(
          "data.restore",
          {
            owner: DATA_BACKUP_OWNER,
            name: arguments_.name,
            fileName: userBackupFileName(arguments_.name),
            schemaVersion: inspected.value.schemaVersion,
            confirmation: "refused",
            inspection,
          },
          [
            fromUnknown(
              new Error("the confirmed backup name does not match the requested restore"),
              {
                operation: "confirm restore",
              },
            ),
          ],
          { kind: "failed", effect: "none" },
          MUTATION_NOT_OBSERVED,
        );
      }

      await opened.context.store.close(signal);
      onMutationStart?.();
      const restored = await restoreUserBackup(options, arguments_.name, signal);
      if (!restored.ok) {
        return backupFailure("data.restore", restored.error, MUTATION_NOT_OBSERVED);
      }
      return resultFor(
        "data.restore",
        {
          owner: DATA_BACKUP_OWNER,
          name: restored.value.name,
          fileName: userBackupFileName(restored.value.name),
          schemaVersion: restored.value.schemaVersion,
          confirmation: "applied",
          inspection,
        },
        [],
        undefined,
        WRITE_COMPLETED_EFFECT,
      );
    } finally {
      if (!opened.context.store.isClosed()) {
        await opened.context.store.close(signal);
      }
    }
  } catch (error) {
    return resultFor(
      "data.restore",
      null,
      [fromUnknown(error, { operation: "restore local backup" })],
      undefined,
      arguments_.confirmation === null ? READ_ONLY_EFFECT : MUTATION_NOT_OBSERVED,
    );
  }
}

/** Collects local facts about the open database; never a bundle or network. */
export async function runDataDiagnostics(
  services: ServiceProvider,
  signal?: AbortSignal,
): Promise<CommandResultOf<"data.diagnostics", DataDiagnosticsPayload>> {
  try {
    const opened = await openBackupContext(services, signal);
    if (!opened.ok) {
      return resultFor("data.diagnostics", null, opened.errors);
    }

    try {
      const collected = await collectLocalDiagnostics(
        backupOptionsFor(opened.context, services),
        signal,
      );
      if (!collected.ok) {
        return backupFailure("data.diagnostics", collected.error);
      }
      const sweep = collected.value.sweep;
      return resultFor("data.diagnostics", {
        owner: DATA_BACKUP_OWNER,
        schemaVersion: collected.value.schemaVersion,
        crashSignals: collected.value.crashSignals,
        sweep:
          sweep === null
            ? null
            : {
                examined: sweep.examined,
                deleted: sweep.deleted,
                failed: sweep.failed,
                completeness: sweep.completeness,
                effect: sweep.effect,
              },
      });
    } finally {
      await opened.context.store.close(signal);
    }
  } catch (error) {
    return resultFor("data.diagnostics", null, [
      fromUnknown(error, { operation: "collect local diagnostics" }),
    ]);
  }
}
