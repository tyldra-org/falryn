import { createRuntimeProjectionRedactor } from "../../application/diagnostics/redaction.ts";
import {
  createProductResources,
  type ProductResources,
} from "../../application/orchestration/product-resources.ts";
import { createSessionExportAction } from "../../application/sessions/session-export.ts";
import { listPackageData } from "../../data/extensions/package-data-inventory.ts";
/** Export preview and package-writing command family. */

import {
  fromExportError,
  fromSqliteStoreError,
  fromUnknown,
} from "../../application/diagnostics/index.ts";
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
import { createInMemoryPackageWriter } from "../../domain/extensions/index.ts";
import type {
  ExportCounts,
  ExportInventory,
  ExportOmission,
  ExportRedaction,
  ExportSelectionSummary,
} from "../../domain/sessions/index.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  isRootUsable,
  type RootStatus,
} from "../../domain/storage/index.ts";
import { joinPath, type LocalPath } from "../../domain/workspace/index.ts";
import {
  createHostBlobStore,
  createHostPackageWriter,
  createSha256Hasher,
  openBunSqlite,
} from "../../integrations/index.ts";
import type { ExportCommandArguments } from "../command-tree.ts";
import { type CommandEffect, type CommandResultOf, READ_ONLY_EFFECT } from "../output/result.ts";
import { packageDataForSessionExport } from "../runtime/package-data-history.ts";
import type { ServiceProvider } from "../runtime/services.ts";
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
  resources?: ProductResources,
): Promise<CommandResultOf<"export", ExportCommandPayload>> {
  try {
    return await exportThroughStore(services, arguments_, signal, onMutationStart, resources);
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
  resourceOwner: ProductResources | undefined,
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
      redactor: createRuntimeProjectionRedactor(),
    };

    const name = arguments_.name;
    if (arguments_.write && name === null)
      return resultFor<"export", ExportCommandPayload>("export", null, [
        fromUnknown(new Error("export write is missing a package name"), {
          operation: "write export",
        }),
      ]);
    const resources = (resourceOwner ?? createProductResources(clock)).openTask("export");
    const action = createSessionExportAction({
      inventory: (selection, signal) => resolveInventory(options, selection, signal),
      write(name, selection, inventory, signal) {
        onMutationStart?.();
        return writePackage(
          {
            ...options,
            packageData: packageDataForSessionExport(
              listPackageData(opened.value, false, 64),
              inventory.sessionIds,
            ),
          },
          name,
          selection,
          inventory,
          signal,
        );
      },
    });
    const result = await action
      .run(
        arguments_.write && name !== null
          ? { mode: "write", name, selection: arguments_.selection }
          : { mode: "preview", selection: arguments_.selection },
        resources,
        signal,
      )
      .finally(() => resources.close());
    if (result.kind === "failed") return exportFailure(arguments_, result.error);
    if (result.kind === "unavailable")
      return resultFor<"export", ExportCommandPayload>(
        "export",
        null,
        [fromUnknown(new Error(result.reason), { operation: "export" })],
        result.effect === "uncertain"
          ? { kind: "uncertain", effect: "uncertain" }
          : { kind: "failed", effect: "none" },
        { intent: arguments_.write ? "mutate" : "none", observed: result.effect },
      );
    if (result.written === null)
      return resultFor(
        "export",
        payloadFromInventory("preview", arguments_.selection, result.inventory, null),
      );
    const written = result.written;
    if (name === null) throw new Error("written export requires a name");
    const dest = joinPath(exportsRoot as LocalPath, name);
    const bundle = {
      name,
      path: dest.ok ? dest.value : name,
      byteLength: written.byteLength,
      cancelledAfterFinalize: written.cancelledAfterFinalize,
    };
    const payload = payloadFromInventory(
      "written",
      arguments_.selection,
      result.inventory,
      bundle,
      written.manifest.redactions,
    );
    if (written.cancelledAfterFinalize) {
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
