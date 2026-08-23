/** Read-only CLI opening boundaries for artifact and session storage. */

import {
  createArtifactReader,
  fromSqliteStoreError,
  fromUnknown,
} from "../../application/index.ts";
import {
  createArtifactProvenanceRepository,
  createArtifactRepository,
  createArtifactStore,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  probeStorage,
  rootChild,
  sqliteDatabasePath,
} from "../../data/index.ts";
import {
  blocksLocalData,
  DEFAULT_BUSY_TIMEOUT_MS,
  type FalrynError,
  runId,
} from "../../domain/index.ts";
import {
  createHostBlobStore,
  createSha256Hasher,
  openBunSqlite,
} from "../../integrations/index.ts";
import type { ServiceProvider } from "../services.ts";

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

export async function openArtifactStore(
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

export async function openSessionStore(
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
