/** Export preview and package-writing command family. */

import {
  createRuntimeRedactor,
  fromExportError,
  fromSqliteStoreError,
  fromUnknown,
} from "../../application/index.ts";
import {
  createRecordRepositories,
  createSqliteEventStore,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  resolveInventory,
  rootChild,
  sqliteDatabasePath,
  writePackage,
} from "../../data/index.ts";
import {
  createInMemoryPackageWriter,
  DEFAULT_BUSY_TIMEOUT_MS,
  type ExportCounts,
  type ExportInventory,
  type ExportOmission,
  type ExportRedaction,
  type ExportSelectionSummary,
  isRootUsable,
  joinPath,
  type LocalPath,
  type RootStatus,
} from "../../domain/index.ts";
import {
  createHostBlobStore,
  createHostPackageWriter,
  createSha256Hasher,
  openBunSqlite,
} from "../../integrations/index.ts";
import type { ExportCommandArguments } from "../command-tree.ts";
import { type CommandEffect, type CommandResultOf, READ_ONLY_EFFECT } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import { FALRYN_VERSION } from "../version.ts";
import { MUTATION_NOT_OBSERVED, resultFor, WRITE_COMPLETED_EFFECT } from "./shared.ts";

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
