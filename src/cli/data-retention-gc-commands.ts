/**
 * Retention reporting and reachability GC CLI (#725).
 *
 * `falryn data retention` measures registered ownership classes against
 * configuration budgets. `falryn data gc` previews unreachable sessions and
 * artifacts, then applies only when `--confirm` carries the exact plan identity.
 */

import { createRuntimeRedactor, fromUnknown } from "../application/index.ts";
import { RETENTION_CLASSES } from "../config/index.ts";
import {
  createArtifactRepository,
  createRecordRepositories,
  createSqliteEventStore,
  executeReachabilityGc,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  parseExportDirectoryEntry,
  planReachabilityGc,
  rootChild,
  sqliteDatabasePath,
} from "../data/index.ts";
import {
  baseName,
  blocksLocalData,
  type ClassBudget,
  configurationKeyPath,
  DEFAULT_BUSY_TIMEOUT_MS,
  type ExportName,
  type FalrynError,
  type GcPlan,
  type GcPlanId,
  isGcPlanId,
  isOwnershipClass,
  isRootUsable,
  type LocalPath,
  type OwnershipClass,
  type RetentionPolicy,
  type RetentionReport,
  type RootStatus,
  runId,
  type SessionId,
  sessionId,
  type TerminalOutcome,
} from "../domain/index.ts";
import {
  createHostBlobStore,
  createHostPackageWriter,
  createSha256Hasher,
  openBunSqlite,
} from "../integrations/index.ts";
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
import { FALRYN_VERSION } from "./version.ts";

export const DATA_RETENTION_GC_OWNER = "#725";

const MUTATION_NOT_OBSERVED: CommandEffect = { intent: "mutate", observed: "none" };
const GC_RUN = runId.from("cli-gc");

type SessionStore = Extract<Awaited<ReturnType<typeof openSqliteStore>>, { ok: true }>["value"];

export type DataRetentionPayload = {
  readonly owner: typeof DATA_RETENTION_GC_OWNER;
  readonly report: RetentionReport;
};

export type DataGcPayload = {
  readonly owner: typeof DATA_RETENTION_GC_OWNER;
  readonly plan: GcPlan;
  readonly confirmation: "not-requested" | "applied" | "refused";
  readonly deletedSessions: number | null;
  readonly deletedArtifacts: number | null;
  readonly deletedBytes: number | null;
  readonly failed: number | null;
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

function storageRootReady(status: RootStatus): boolean {
  return isRootUsable(status) || status.code === "insecure-permissions";
}

function retentionPolicyFromValues(values: Record<string, unknown>): RetentionPolicy {
  const byClass: Partial<Record<OwnershipClass, ClassBudget>> = {};
  const retention = values[configurationKeyPath("data.retention")];
  if (typeof retention === "object" && retention !== null) {
    for (const [key, entry] of Object.entries(retention as Record<string, unknown>)) {
      if (
        !isOwnershipClass(key) ||
        !RETENTION_CLASSES.includes(key as (typeof RETENTION_CLASSES)[number])
      ) {
        continue;
      }
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const maxBytes = (entry as { maxBytes?: unknown }).maxBytes;
      byClass[key] = {
        maxBytes: typeof maxBytes === "number" ? maxBytes : null,
        maxItems: null,
      };
    }
  }
  const total = values[configurationKeyPath("data.quotas.totalMaxBytes")];
  return {
    byClass,
    totalMaxBytes: typeof total === "number" ? total : null,
  };
}

async function openRetentionContext(
  services: ServiceProvider,
  signal: AbortSignal | undefined,
): Promise<
  | {
      readonly ok: true;
      readonly store: SessionStore;
      readonly stateRoot: LocalPath;
      readonly artifactsRoot: LocalPath;
      readonly temporaryRoot: LocalPath;
      readonly exportsRoot: LocalPath;
    }
  | { readonly ok: false; readonly errors: readonly FalrynError[] }
> {
  const { localData, clock } = services();
  const rootsToPrepare = ["state", "artifacts", "temporaryIngest", "exports"] as const;
  const statuses = await localData.prepareRoots([...rootsToPrepare], signal);
  for (const root of rootsToPrepare) {
    const status = statuses.find((candidate) => candidate.root === root);
    if (status === undefined || !storageRootReady(status)) {
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
        fromUnknown(new Error("retention storage roots could not be resolved"), {
          operation: "resolve retention roots",
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

  return {
    ok: true,
    store: opened.value,
    stateRoot,
    artifactsRoot,
    temporaryRoot,
    exportsRoot,
  };
}

async function listExportPackageNames(
  services: ServiceProvider,
  exportsRoot: LocalPath,
  signal?: AbortSignal,
): Promise<readonly ExportName[]> {
  const { fileSystem } = services();
  const listed = await fileSystem.list(exportsRoot, signal);
  if (!listed.ok) {
    return [];
  }
  const names: ExportName[] = [];
  for (const entry of listed.value) {
    if (entry.kind !== "file") {
      continue;
    }
    const parsed = parseExportDirectoryEntry(baseName(entry.path));
    if (parsed !== null) {
      names.push(parsed);
    }
  }
  return names;
}

function gcPayload(
  plan: GcPlan,
  confirmation: DataGcPayload["confirmation"],
  execution: {
    readonly deletedSessions: number;
    readonly deletedArtifacts: number;
    readonly deletedBytes: number;
    readonly failed: number;
  } | null,
): DataGcPayload {
  return {
    owner: DATA_RETENTION_GC_OWNER,
    plan,
    confirmation,
    deletedSessions: execution?.deletedSessions ?? null,
    deletedArtifacts: execution?.deletedArtifacts ?? null,
    deletedBytes: execution?.deletedBytes ?? null,
    failed: execution?.failed ?? null,
  };
}

/** Reports retention pressure for every registered ownership class. */
export async function runDataRetention(
  services: ServiceProvider,
  signal?: AbortSignal,
): Promise<CommandResultOf<"data.retention", DataRetentionPayload>> {
  try {
    const { loader, removalData, configurationRoot, legacyConfigurationRoot, workspaceRoot } =
      services();
    const outcome = await loader.load({
      configurationRoot,
      legacyConfigurationRoot,
      workspaceRoot,
      profile: null,
      overrides: {},
    });
    if (outcome.kind === "rejected" && outcome.retained === null) {
      return resultFor("data.retention", null, [
        fromUnknown(new Error("configuration could not be loaded"), {
          operation: "load retention policy",
        }),
      ]);
    }
    const record =
      outcome.kind === "published" || outcome.kind === "unchanged"
        ? outcome.record
        : outcome.kind === "rejected"
          ? outcome.retained
          : null;
    if (record === null) {
      return resultFor("data.retention", null, [
        fromUnknown(new Error("configuration could not be loaded"), {
          operation: "load retention policy",
        }),
      ]);
    }
    const policy = retentionPolicyFromValues(record.values as Record<string, unknown>);
    const report = await removalData.reportRetention(policy, signal);
    return resultFor("data.retention", { owner: DATA_RETENTION_GC_OWNER, report });
  } catch (error) {
    return resultFor("data.retention", null, [
      fromUnknown(error, { operation: "report local data retention" }),
    ]);
  }
}

/** Previews or applies reachability garbage collection. */
export async function runDataGc(
  services: ServiceProvider,
  arguments_: Extract<DataLifecycleArguments, { readonly action: "gc" }>,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"data.gc", DataGcPayload>> {
  try {
    const opened = await openRetentionContext(services, signal);
    if (!opened.ok) {
      return resultFor("data.gc", null, opened.errors, undefined, MUTATION_NOT_OBSERVED);
    }

    const { clock } = services();
    const packages = createHostPackageWriter({ exportsRoot: opened.exportsRoot });
    const exportNames = await listExportPackageNames(services, opened.exportsRoot, signal);
    const repositories = createRecordRepositories(opened.store);
    const exportOptions = {
      store: opened.store,
      repositories,
      events: createSqliteEventStore(opened.store),
      blobs: createHostBlobStore({
        artifactsRoot: opened.artifactsRoot,
        temporaryRoot: opened.temporaryRoot,
      }),
      packages,
      hasher: createSha256Hasher(),
      clock,
      buildIdentity: `falryn/${FALRYN_VERSION}`,
      redactor: createRuntimeRedactor(),
    };
    const pinnedSessionIds: SessionId[] = [];
    for (const value of arguments_.pinnedSessions) {
      const parsed = sessionId.parse(value);
      if (!parsed.ok) {
        return resultFor(
          "data.gc",
          null,
          [
            fromUnknown(new Error("pinned session identity is malformed"), {
              operation: "parse pin",
            }),
          ],
          undefined,
          MUTATION_NOT_OBSERVED,
        );
      }
      pinnedSessionIds.push(parsed.value);
    }

    const inputs = {
      store: opened.store,
      repositories,
      blobs: exportOptions.blobs,
      packages,
      exportOptions,
      pinnedSessionIds,
      exportPackageNames: exportNames,
    };

    try {
      const planned = await planReachabilityGc(inputs, signal);
      if (!planned.ok) {
        return resultFor(
          "data.gc",
          null,
          [
            fromUnknown(new Error(planned.error.code), {
              operation: "plan reachability garbage collection",
            }),
          ],
          undefined,
          MUTATION_NOT_OBSERVED,
        );
      }

      if (arguments_.confirmation === null) {
        return resultFor(
          "data.gc",
          gcPayload(planned.value, "not-requested", null),
          [],
          undefined,
          READ_ONLY_EFFECT,
        );
      }

      if (!isGcPlanId(arguments_.confirmation)) {
        return resultFor(
          "data.gc",
          gcPayload(planned.value, "refused", null),
          [
            fromUnknown(new Error("the confirmed plan identity is malformed"), {
              operation: "confirm garbage collection",
            }),
          ],
          { kind: "failed", effect: "none" },
          MUTATION_NOT_OBSERVED,
        );
      }

      if (planned.value.planId !== arguments_.confirmation) {
        return resultFor(
          "data.gc",
          gcPayload(planned.value, "refused", null),
          [
            fromUnknown(new Error("the confirmed plan identity does not match the current plan"), {
              operation: "confirm garbage collection",
            }),
          ],
          { kind: "failed", effect: "none" },
          MUTATION_NOT_OBSERVED,
        );
      }

      onMutationStart?.();
      const repository = createArtifactRepository(opened.store, GC_RUN);
      const executed = await executeReachabilityGc(
        inputs,
        planned.value,
        { planId: arguments_.confirmation as GcPlanId },
        repository,
        signal,
      );
      if (!executed.ok) {
        return resultFor(
          "data.gc",
          gcPayload(planned.value, "refused", null),
          [
            fromUnknown(new Error(executed.error.code), {
              operation: "apply garbage collection plan",
            }),
          ],
          { kind: "failed", effect: "none" },
          MUTATION_NOT_OBSERVED,
        );
      }

      const outcome: TerminalOutcome | undefined =
        executed.value.effect === "partial"
          ? { kind: "failed", effect: "partial" as const }
          : undefined;
      return resultFor(
        "data.gc",
        gcPayload(planned.value, "applied", executed.value),
        [],
        outcome,
        { intent: "mutate", observed: executed.value.effect },
      );
    } finally {
      await opened.store.close(signal);
    }
  } catch (error) {
    return resultFor(
      "data.gc",
      null,
      [fromUnknown(error, { operation: "garbage-collect local data" })],
      undefined,
      arguments_.confirmation === null ? READ_ONLY_EFFECT : MUTATION_NOT_OBSERVED,
    );
  }
}
