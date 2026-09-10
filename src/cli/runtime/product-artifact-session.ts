/** Durable event, artifact, and Loom lifecycle for one product process. */

import { createHash, randomUUID } from "node:crypto";
import {
  createScratchResources,
  type ScratchResourcePort,
} from "../../application/artifacts/index.ts";
import { createLoomPort, type LoomPort } from "../../application/compression/index.ts";
import type { CatalogRehydration } from "../../application/extensions/catalog-rehydration.ts";
import { createDurableMemoryRecords, type MemoryRecords } from "../../application/memory/index.ts";
import { type AgentJoins, createAgentJoins } from "../../application/orchestration/agent-joins.ts";
import {
  createProcessTaskNotices,
  type ProcessTaskNotices,
} from "../../application/orchestration/process-task-notices.ts";
import {
  type ProcessTaskRecovery,
  reconcileProcessTasks,
  watchProcessTaskRecovery,
} from "../../application/orchestration/process-task-recovery.ts";
import {
  createProcessTaskSupervisor,
  type ProcessTaskSupervisor,
} from "../../application/orchestration/process-task-supervisor.ts";
import {
  createStructuredQuestions,
  type StructuredQuestions,
} from "../../application/orchestration/structured-questions.ts";
import { createCatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
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
} from "../../data/index.ts";
import { createAgentJoinStore } from "../../data/orchestration/agent-join-store.ts";
import { createMailboxRepository } from "../../data/orchestration/mailbox-store.ts";
import { createSqliteProcessTaskStore } from "../../data/orchestration/process-task-store.ts";
import { createQuestionStore } from "../../data/orchestration/question-store.ts";
import {
  createWorkQueueLocations,
  type WorkQueueLocations,
} from "../../data/orchestration/work-queue-locations.ts";
import { runId } from "../../domain/foundation/index.ts";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  isCleanClose,
  isRootUsable,
  type RootStatus,
} from "../../domain/storage/index.ts";
import { joinPath, type LocalPath } from "../../domain/workspace/index.ts";
import {
  createHostBlobStore,
  createSha256Hasher,
  openBunSqlite,
} from "../../integrations/index.ts";
import type { OwnedProcessRegistry } from "../../integrations/process/host-owned-process-registry.ts";
import { createHostProcessIdentityPort } from "../../integrations/process/host-process-identity.ts";
import type { ProviderContinuationStatePort } from "../../providers/index.ts";
import { composeExtensionCatalog } from "./extension-catalog.ts";
import {
  composeProductPeerMailboxes,
  type ProductPeerMailboxes,
} from "./product-peer-mailboxes.ts";
import type { Services } from "./services.ts";

export type ProductArtifactSession = {
  readonly workQueues: WorkQueueLocations;
  readonly peers: ProductPeerMailboxes;
  readonly artifacts: DurableArtifactStore;
  readonly eventStore: DurableEventStore;
  readonly loom: LoomPort;
  readonly memoryRecords: MemoryRecords;
  readonly modelCatalogs: ModelCatalogGenerationRepository;
  readonly providerContinuations: ProviderContinuationStatePort;
  readonly scratch: ScratchResourcePort;
  readonly tasks: ProcessTaskSupervisor;
  readonly joins: AgentJoins;
  readonly questions: StructuredQuestions | null;
  readonly taskNotices: ProcessTaskNotices;
  readonly taskRecovery: readonly ProcessTaskRecovery[];
  rehydrateExtensions(signal: AbortSignal, session?: string): Promise<CatalogRehydration>;
  openWorkspaceIndex(
    workspaceRoot: LocalPath,
    signal?: AbortSignal,
  ): Promise<WorkspaceIndexStore | null>;
  close(signal?: AbortSignal): Promise<boolean>;
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
  ownedProcesses?: OwnedProcessRegistry,
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
  const workQueues = createWorkQueueLocations({
    state: store,
    stateRoot,
    clock: services.clock,
    open: openBunSqlite,
  });
  const run = beginRun({
    store,
    clock: services.clock,
    runId: runId.from(`product-artifacts-${randomUUID()}`),
  });
  if (!run.ok) {
    await store.close();
    return null;
  }
  const runSession = run.value;

  const artifacts = createArtifactStore({
    repository: createArtifactRepository(store, run.value.record.runId),
    blobs: createHostBlobStore({ artifactsRoot, temporaryRoot }),
    hasher: createSha256Hasher(),
    clock: services.clock,
  });
  const eventStore = createSqliteEventStore(store, { projectStartedRecords: true });
  const peers = composeProductPeerMailboxes(services, createMailboxRepository(store), artifacts);
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
  const identities = createHostProcessIdentityPort();
  const processIdentity = await identities.inspect(process.pid);
  const taskStore = createSqliteProcessTaskStore(store);
  const joins = createAgentJoins({
    store: createAgentJoinStore(store),
    tasks: taskStore,
    artifacts,
  });
  const recovered = await reconcileProcessTasks({
    store: taskStore,
    identities,
    now: () => Number(services.clock.now()),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!recovered.ok) {
    await artifacts.quiesce();
    await eventStore.quiesce();
    run.value.end();
    await store.close();
    return null;
  }
  const taskNotices = createProcessTaskNotices(eventStore);
  let questions: StructuredQuestions | null = null;
  const tasks = createProcessTaskSupervisor({
    store: taskStore,
    artifacts,
    clock: services.clock,
    runId: String(run.value.record.runId),
    process: processIdentity.kind === "present" ? processIdentity.identity : null,
    notify: (notice, signal) =>
      notice.task.executionKind === "question"
        ? (questions?.notify(notice, signal) ?? Promise.resolve(false))
        : (() => {
            const visible = joins.store.notificationBoundary(notice.task.handle);
            return visible.ok
              ? visible.value
                ? taskNotices.notify(notice, signal)
                : Promise.resolve(true)
              : Promise.resolve(false);
          })(),
  });
  questions = createStructuredQuestions({
    store: createQuestionStore(store, {
      runId: String(run.value.record.runId),
      process: null,
    }),
    tasks: taskStore,
    clock: services.clock,
    deliver: tasks.deliver,
  });
  if (!questions.recover().ok) {
    questions.close();
    questions = null;
  }
  const listed = taskStore.list();
  if (listed.ok)
    for (const task of listed.value)
      if (task.state === "terminal" && task.executionKind !== "question") await tasks.deliver(task);
  const recovery = watchProcessTaskRecovery({
    store: taskStore,
    identities,
    clock: services.clock,
    initial: recovered.value,
    settled: (task) => tasks.deliver(task),
  });
  const interrupt = () => tasks.interrupt();
  signal?.addEventListener("abort", interrupt, { once: true });
  if (signal?.aborted) interrupt();
  const indexes = new Map<string, WorkspaceIndexStore>();
  let closed = false;
  let closing: Promise<boolean> | null = null;

  async function closeStores(): Promise<boolean> {
    closed = true;
    let clean = true;
    if (questions !== null && !questions.close()) clean = false;
    const attempt = async (close: () => void | Promise<void>) => {
      try {
        await close();
      } catch {
        clean = false;
      }
    };
    await attempt(async () => {
      if (!(await recovery.close())) clean = false;
    });
    await attempt(() => peers.close());
    await attempt(async () => {
      if (!(await tasks.drain()).ok) clean = false;
    });
    for (const index of indexes.values()) await attempt(() => index.close());
    await attempt(() => artifacts.quiesce());
    await attempt(() => eventStore.quiesce());
    await attempt(() => {
      if (!runSession.end().ok) clean = false;
    });
    await attempt(async () => {
      if (!isCleanClose(await store.close())) clean = false;
    });
    await attempt(async () => {
      if (!(await workQueues.close())) clean = false;
    });
    signal?.removeEventListener("abort", interrupt);
    taskNotices.dispose();
    return clean;
  }
  const session: ProductArtifactSession = {
    workQueues,
    async rehydrateExtensions(signal, session) {
      if (closed) return { status: "failed", code: "catalog-host-closed" };
      const owner = composeExtensionCatalog({
        services,
        records: createCatalogRepositories(store),
        ...(session === undefined ? {} : { session }),
      });
      const result = await owner.refresh(signal);
      return closed ? { status: "failed", code: "catalog-host-closed" } : result;
    },
    peers,
    tasks,
    joins,
    questions,
    taskNotices,
    get taskRecovery() {
      return recovery.reports();
    },
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
    close(closeSignal) {
      if (closeSignal?.aborted) interrupt();
      closing ??= closeStores();
      return closing;
    },
  };
  if (
    ownedProcesses !== undefined &&
    !ownedProcesses.retain({ interrupt, drain: () => session.close() })
  ) {
    interrupt();
    await session.close();
    return null;
  }
  return session;
}
