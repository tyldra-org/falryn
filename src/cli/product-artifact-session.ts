/** Durable event, artifact, and Loom lifecycle for one product process. */

import { randomUUID } from "node:crypto";

import { createLoomPort, type LoomPort } from "../application/index.ts";
import {
  beginRun,
  createArtifactRepository,
  createArtifactStore,
  createSqliteEventStore,
  type DurableArtifactStore,
  type DurableEventStore,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../data/index.ts";
import { DEFAULT_BUSY_TIMEOUT_MS, isRootUsable, type RootStatus, runId } from "../domain/index.ts";
import { createHostBlobStore, createSha256Hasher, openBunSqlite } from "../integrations/index.ts";
import type { Services } from "./services.ts";

export type ProductArtifactSession = {
  readonly artifacts: DurableArtifactStore;
  readonly eventStore: DurableEventStore;
  readonly loom: LoomPort;
  close(signal?: AbortSignal): Promise<void>;
};

function rootReady(status: RootStatus): boolean {
  return isRootUsable(status) || status.code === "insecure-permissions";
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
  const eventStore = createSqliteEventStore(store);
  const loom = createLoomPort({ artifacts });
  let closed = false;

  return {
    artifacts,
    eventStore,
    loom,
    async close(closeSignal) {
      if (closed) {
        return;
      }
      closed = true;
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
    },
  };
}
