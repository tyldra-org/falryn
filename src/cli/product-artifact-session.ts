/** Durable event, artifact, and Loom lifecycle for one product process. */

import { createHash, randomUUID } from "node:crypto";

import {
  createDurableMemoryRecords,
  createLoomPort,
  createScratchResources,
  type LoomPort,
  type MemoryRecords,
  type ScratchResourcePort,
} from "../application/index.ts";
import {
  beginRun,
  createArtifactRepository,
  createArtifactStore,
  createLoomManifestRepository,
  createMemoryRecordRepository,
  createModelCatalogGenerationRepository,
  createProviderContinuationStateRepository,
  createScratchResourceRepository,
  createSqliteEventStore,
  type DurableArtifactStore,
  type DurableEventStore,
  type ModelCatalogGenerationRepository,
  openSqliteStore,
  openWorkspaceIndexStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
  type WorkspaceIndexStore,
} from "../data/index.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  isRootUsable,
  joinPath,
  type LocalPath,
  type RootStatus,
  runId,
} from "../domain/index.ts";
import { createHostBlobStore, createSha256Hasher, openBunSqlite } from "../integrations/index.ts";
import type { ProviderContinuationStatePort } from "../providers/index.ts";
import type { Services } from "./services.ts";

export type ProductArtifactSession = {
  readonly artifacts: DurableArtifactStore;
  readonly eventStore: DurableEventStore;
  readonly loom: LoomPort;
  readonly memoryRecords: MemoryRecords;
  readonly modelCatalogs: ModelCatalogGenerationRepository;
  readonly providerContinuations: ProviderContinuationStatePort;
  readonly scratch: ScratchResourcePort;
  openWorkspaceIndex(
    workspaceRoot: LocalPath,
    signal?: AbortSignal,
  ): Promise<WorkspaceIndexStore | null>;
  close(signal?: AbortSignal): Promise<void>;
};

function rootReady(status: RootStatus): boolean {
  return isRootUsable(status) || status.code === "insecure-permissions";
}

function workspaceIndexPath(stateRoot: LocalPath, workspaceRoot: LocalPath): LocalPath | null {
  const digest = createHash("sha256").update(String(workspaceRoot)).digest("hex").slice(0, 24);
  const path = joinPath(stateRoot, `workspace-index-${digest}.sqlite`);
  return path.ok ? path.value : null;
}

/**
 * Open the shared durable event and exact-output stores for a live product
 * host. Failure degrades to bounded inline reads and fail-closed live turns; it
 * never fabricates persistence or recovery.
 */
export async function openProductArtifactSession(
  services: Services,
  signal?: AbortSignal,
): Promise<ProductArtifactSession | null> {
  const roots = ["state", "artifacts", "temporaryIngest"] as const;
  const prepared = await services.localData.prepareRoots([...roots], signal);
  for (const root of roots) {
    const status = prepared.find((candidate) => candidate.root === root);
    if (status === undefined || !rootReady(status)) {
      return null;
    }
  }

  const stateRoot = rootChild(services.localData.layout, "state");
  const artifactsRoot = rootChild(services.localData.layout, "artifacts");
  const temporaryRoot = rootChild(services.localData.layout, "temporaryIngest");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (
    stateRoot === null ||
    databasePath === null ||
    artifactsRoot === null ||
    temporaryRoot === null
  ) {
    return null;
  }

  const opened = await openSqliteStore(
    {
      open: openBunSqlite,
      clock: services.clock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    },
    signal,
  );
  if (!opened.ok) {
    return null;
  }

  const store = opened.value;
  const run = beginRun({
    store,
    clock: services.clock,
    runId: runId.from(`product-artifacts-${randomUUID()}`),
  });
  if (!run.ok) {
    await store.close();
    return null;
  }

  const artifacts = createArtifactStore({
    repository: createArtifactRepository(store, run.value.record.runId),
    blobs: createHostBlobStore({ artifactsRoot, temporaryRoot }),
    hasher: createSha256Hasher(),
    clock: services.clock,
  });
  const eventStore = createSqliteEventStore(store, { projectStartedRecords: true });
  const loom = createLoomPort({
    artifacts,
    manifests: createLoomManifestRepository({ store, clock: services.clock }),
  });
  const scratch = createScratchResources({
    artifacts,
    repository: createScratchResourceRepository(store),
    clock: services.clock,
  });
  const durableMemory = createDurableMemoryRecords(createMemoryRecordRepository(store));
  if (!durableMemory.ok) {
    await artifacts.quiesce(signal);
    await eventStore.quiesce();
    run.value.end(signal);
    await store.close();
    return null;
  }
  const indexes = new Map<string, WorkspaceIndexStore>();
  let closed = false;

  return {
    artifacts,
    eventStore,
    loom,
    memoryRecords: durableMemory.value,
    modelCatalogs: createModelCatalogGenerationRepository(store),
    providerContinuations: createProviderContinuationStateRepository(store),
    scratch,
    async openWorkspaceIndex(workspaceRoot, openSignal) {
      if (closed || openSignal?.aborted === true) {
        return null;
      }
      const key = String(workspaceRoot);
      const existing = indexes.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const path = workspaceIndexPath(stateRoot, workspaceRoot);
      if (path === null) {
        return null;
      }
      const openedIndex = await openWorkspaceIndexStore(
        {
          open: openBunSqlite,
          clock: services.clock,
          databasePath: path,
          backupDirectory: stateRoot,
        },
        openSignal,
      );
      if (!openedIndex.ok) {
        return null;
      }
      indexes.set(key, openedIndex.value);
      return openedIndex.value;
    },
    async close(closeSignal) {
      if (closed) {
        return;
      }
      closed = true;
      try {
        for (const index of indexes.values()) {
          await index.close();
        }
      } finally {
        try {
          await artifacts.quiesce(closeSignal);
        } finally {
          try {
            await eventStore.quiesce();
          } finally {
            run.value.end(closeSignal);
            await store.close();
          }
        }
      }
    },
  };
}
