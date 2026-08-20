/**
 * Spill an over-bound machine result into the durable artifact store.
 *
 * The CLI projection calls this when a terminal record exceeds
 * `MAX_CLI_RECORD_BYTES`. The refusal still emits if the store is unreachable
 * or the write fails — the run's outcome must never be lost because storage was
 * unavailable.
 */

import {
  beginRun,
  createArtifactRepository,
  createArtifactStore,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  rootChild,
  sqliteDatabasePath,
} from "../data/index.ts";
import {
  artifactId,
  DEFAULT_BUSY_TIMEOUT_MS,
  isRootUsable,
  type RootStatus,
  runId,
} from "../domain/index.ts";
import { createHostBlobStore, createSha256Hasher, openBunSqlite } from "../integrations/index.ts";
import type { OverBoundArtifactWriter } from "./render-json.ts";
import type { ServiceProvider } from "./services.ts";

/** Stable origin for bytes that exist only because a machine record spilled. */
const REFUSAL_ORIGIN = "diagnostic" as const;

/** Media type of a spilled `falryn.cli` terminal record. */
const REFUSAL_MEDIA_TYPE = "application/json";

/**
 * Builds the writer dispatch hands to the machine projections.
 *
 * Each call opens its own short-lived store session: spilling is rare, and a
 * long-lived write path would force every machine run to prepare artifact roots
 * whether or not a refusal ever happens.
 */
export function createOverBoundArtifactWriter(
  services: ServiceProvider,
  signal?: AbortSignal,
): OverBoundArtifactWriter {
  return async (input) => {
    try {
      return await writeOverBoundArtifact(services, input.bytes, signal);
    } catch {
      return { ok: false, code: "store-failed" };
    }
  };
}

function rootReady(status: RootStatus): boolean {
  return isRootUsable(status) || status.code === "insecure-permissions";
}

async function writeOverBoundArtifact(
  services: ServiceProvider,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly artifact: { readonly artifactId: string } }
  | { readonly ok: false; readonly code: "store-unavailable" | "store-failed" }
> {
  const { localData, clock } = services();
  const roots = ["state", "artifacts", "temporaryIngest"] as const;
  const prepared = await localData.prepareRoots([...roots], signal);
  for (const root of roots) {
    const status = prepared.find((candidate) => candidate.root === root);
    if (status === undefined || !rootReady(status)) {
      return { ok: false, code: "store-unavailable" };
    }
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
    return { ok: false, code: "store-unavailable" };
  }

  const opened = await openSqliteStore(
    {
      open: openBunSqlite,
      clock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    },
    signal,
  );
  if (!opened.ok) {
    return { ok: false, code: "store-unavailable" };
  }

  const store = opened.value;
  const thisRun = runId.from(`cli-refusal-${crypto.randomUUID()}`);
  try {
    const begun = beginRun({ store, clock, runId: thisRun });
    if (!begun.ok) {
      return { ok: false, code: "store-failed" };
    }

    const repository = createArtifactRepository(store, thisRun);
    const artifactStore = createArtifactStore({
      repository,
      blobs: createHostBlobStore({ artifactsRoot, temporaryRoot }),
      hasher: createSha256Hasher(),
      clock,
    });

    const id = artifactId.from(`cli-refusal-${crypto.randomUUID()}`);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield bytes;
    }
    const ingested = await artifactStore.ingest(
      {
        artifactId: id,
        mediaType: REFUSAL_MEDIA_TYPE,
        encoding: "identity",
        sensitivity: "user-content",
        origin: REFUSAL_ORIGIN,
        invocationId: null,
        declaredByteLength: bytes.byteLength,
        content: chunks(),
      },
      signal,
    );
    begun.value.end(signal);
    if (!ingested.ok) {
      return { ok: false, code: "store-failed" };
    }
    return { ok: true, artifact: { artifactId: String(ingested.value.record.artifactId) } };
  } finally {
    await store.close();
  }
}
