/**
 * Import and effect-free session rebuild CLI (#723).
 *
 * `falryn import` applies a verified export package to local storage.
 * `falryn replay` rebuilds turns and artifacts from durable facts without
 * repeating provider or tool effects. This is not `falryn session replay`,
 * which moves a cursor over recorded events (#721).
 */

import { createRuntimeRedactor, fromImportError, fromUnknown } from "../application/index.ts";
import {
  beginRun,
  createRecordRepositories,
  createSqliteEventStore,
  importPackage,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  replaySession,
  rootChild,
  sqliteDatabasePath,
} from "../data/index.ts";
import {
  blocksLocalData,
  DEFAULT_BUSY_TIMEOUT_MS,
  type FalrynError,
  isRootUsable,
  type LocalPath,
  type RootStatus,
  runId,
  type TerminalOutcome,
} from "../domain/index.ts";
import {
  createHostBlobStore,
  createHostPackageWriter,
  createSha256Hasher,
  openBunSqlite,
} from "../integrations/index.ts";
import type { ImportCommandArguments, ReplayCommandArguments } from "./command-tree.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandId,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";
import type { ServiceProvider } from "./services.ts";
import { FALRYN_VERSION } from "./version.ts";

export const IMPORT_REPLAY_OWNER = "#723";

const WRITE_COMPLETED_EFFECT: CommandEffect = { intent: "mutate", observed: "completed" };
const MUTATION_NOT_OBSERVED: CommandEffect = { intent: "mutate", observed: "none" };
const CLI_IMPORT_RUN = runId.from("cli-import");

type SessionStore = Extract<Awaited<ReturnType<typeof openSqliteStore>>, { ok: true }>["value"];

export type ImportCommandPayload = {
  readonly owner: typeof IMPORT_REPLAY_OWNER;
  readonly name: string;
  readonly sessionIds: readonly string[];
  readonly events: number;
  readonly artifacts: number;
};

export type ReplayCommandPayload = {
  readonly owner: typeof IMPORT_REPLAY_OWNER;
  readonly sessionId: string;
  readonly streamId: string;
  readonly turnCount: number;
  readonly artifactCount: number;
  readonly truncated: boolean;
  readonly effectFree: true;
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

function importRootReady(status: RootStatus): boolean {
  return isRootUsable(status) || status.code === "insecure-permissions";
}

async function openImportStore(
  services: ServiceProvider,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly store: SessionStore; readonly exportsRoot: LocalPath }
  | { readonly ok: false; readonly errors: readonly FalrynError[] }
> {
  const { localData, clock } = services();
  const rootsToPrepare = ["state", "artifacts", "exports", "temporaryIngest"] as const;
  const statuses = await localData.prepareRoots([...rootsToPrepare], signal);
  for (const root of rootsToPrepare) {
    const status = statuses.find((candidate) => candidate.root === root);
    if (status === undefined || !importRootReady(status)) {
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
  const artifactsRoot = rootChild(localData.layout, "artifacts");
  const temporaryRoot = rootChild(localData.layout, "temporaryIngest");
  const exportsRoot = rootChild(localData.layout, "exports");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (
    stateRoot === null ||
    databasePath === null ||
    artifactsRoot === null ||
    temporaryRoot === null ||
    exportsRoot === null
  ) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("import storage roots could not be resolved"), {
          operation: "resolve import roots",
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

  const begun = beginRun({ store: opened.value, clock, runId: CLI_IMPORT_RUN });
  if (!begun.ok && begun.error.code !== "already-exists") {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the import run could not be started"), {
          operation: "begin import run",
        }),
      ],
    };
  }

  return { ok: true, store: opened.value, exportsRoot: exportsRoot as LocalPath };
}

function importOptionsFor(
  store: SessionStore,
  exportsRoot: LocalPath,
  artifactsRoot: LocalPath,
  temporaryRoot: LocalPath,
  clock: ReturnType<ServiceProvider>["clock"],
) {
  return {
    store,
    repositories: createRecordRepositories(store),
    events: createSqliteEventStore(store),
    blobs: createHostBlobStore({ artifactsRoot, temporaryRoot }),
    packages: createHostPackageWriter({ exportsRoot }),
    hasher: createSha256Hasher(),
    clock,
    buildIdentity: `falryn/${FALRYN_VERSION}`,
    redactor: createRuntimeRedactor(),
    runId: CLI_IMPORT_RUN,
  };
}

function importFailure(
  error: Parameters<typeof fromImportError>[0],
  effect?: CommandEffect,
): CommandResultOf<"import", ImportCommandPayload> {
  const translated = fromImportError(error, { operation: "import" });
  const cancelled = translated.category === "cancellation";
  return resultFor(
    "import",
    null,
    [translated],
    cancelled ? { kind: "cancelled", effect: "none" } : { kind: "failed", effect: "none" },
    effect ?? MUTATION_NOT_OBSERVED,
  );
}

/** Import a verified export package from the exports root into local storage. */
export async function runImport(
  services: ServiceProvider,
  arguments_: ImportCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"import", ImportCommandPayload>> {
  try {
    const opened = await openImportStore(services, signal);
    if (!opened.ok) {
      return resultFor("import", null, opened.errors, undefined, MUTATION_NOT_OBSERVED);
    }

    const { localData, clock } = services();
    const artifactsRoot = rootChild(localData.layout, "artifacts");
    const temporaryRoot = rootChild(localData.layout, "temporaryIngest");
    if (artifactsRoot === null || temporaryRoot === null) {
      return resultFor(
        "import",
        null,
        [
          fromUnknown(new Error("artifact storage roots could not be resolved"), {
            operation: "resolve import roots",
          }),
        ],
        undefined,
        MUTATION_NOT_OBSERVED,
      );
    }

    onMutationStart?.();
    try {
      const imported = await importPackage(
        importOptionsFor(
          opened.store,
          opened.exportsRoot,
          artifactsRoot as LocalPath,
          temporaryRoot as LocalPath,
          clock,
        ),
        arguments_.name,
        signal,
      );
      if (!imported.ok) {
        return importFailure(imported.error, MUTATION_NOT_OBSERVED);
      }
      return resultFor(
        "import",
        {
          owner: IMPORT_REPLAY_OWNER,
          name: arguments_.name,
          sessionIds: imported.value.sessionIds.map((id) => id),
          events: imported.value.events,
          artifacts: imported.value.artifacts,
        },
        [],
        undefined,
        WRITE_COMPLETED_EFFECT,
      );
    } finally {
      await opened.store.close(signal);
    }
  } catch (error) {
    return resultFor(
      "import",
      null,
      [fromUnknown(error, { operation: "import" })],
      undefined,
      MUTATION_NOT_OBSERVED,
    );
  }
}

/** Rebuild a session from stored facts without repeating external effects. */
export async function runReplay(
  services: ServiceProvider,
  arguments_: ReplayCommandArguments,
  signal?: AbortSignal,
): Promise<CommandResultOf<"replay", ReplayCommandPayload>> {
  try {
    const opened = await openImportStore(services, signal);
    if (!opened.ok) {
      return resultFor("replay", null, opened.errors);
    }

    const { localData, clock } = services();
    const artifactsRoot = rootChild(localData.layout, "artifacts");
    const temporaryRoot = rootChild(localData.layout, "temporaryIngest");
    if (artifactsRoot === null || temporaryRoot === null) {
      return resultFor("replay", null, [
        fromUnknown(new Error("artifact storage roots could not be resolved"), {
          operation: "resolve replay roots",
        }),
      ]);
    }

    try {
      const replayed = await replaySession(
        importOptionsFor(
          opened.store,
          opened.exportsRoot,
          artifactsRoot as LocalPath,
          temporaryRoot as LocalPath,
          clock,
        ),
        arguments_.sessionId,
        signal,
      );
      if (!replayed.ok) {
        const translated = fromImportError(replayed.error, { operation: "replay session" });
        const cancelled = translated.category === "cancellation";
        return resultFor(
          "replay",
          null,
          [translated],
          cancelled ? { kind: "cancelled", effect: "none" } : { kind: "failed", effect: "none" },
        );
      }
      return resultFor("replay", {
        owner: IMPORT_REPLAY_OWNER,
        sessionId: replayed.value.sessionId,
        streamId: replayed.value.streamId,
        turnCount: replayed.value.turns.length,
        artifactCount: replayed.value.artifacts.length,
        truncated: replayed.value.truncated,
        effectFree: true,
      });
    } finally {
      await opened.store.close(signal);
    }
  } catch (error) {
    return resultFor("replay", null, [fromUnknown(error, { operation: "replay session" })]);
  }
}
