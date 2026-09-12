/** Compose the shared reader over SQLite metadata and retained blob bytes. */
import type {
  ArtifactRecord,
  BlobStorePort,
  ContentHasherPort,
} from "../../domain/artifacts/index.ts";
import { type ClockPort, runId } from "../../domain/foundation/index.ts";
import { createHistoryReader } from "../../domain/sessions/history-reader.ts";
import type { EventStorePort, RuntimeEvent } from "../../domain/sessions/index.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createArtifactRepository } from "../artifacts/artifact-repository.ts";
import { createArtifactStore } from "../artifacts/artifact-store.ts";
export function createStoredHistoryReader(
  options: {
    readonly store: SqliteStorePort;
    readonly events: EventStorePort;
    readonly blobs: BlobStorePort;
    readonly hasher: ContentHasherPort;
    readonly clock: ClockPort;
  },
  authorize: (event: RuntimeEvent, artifact: ArtifactRecord | null) => boolean,
  redactDeniedEvidence = false,
) {
  const artifacts = createArtifactStore({
    repository: createArtifactRepository(options.store, runId.from("history-reader")),
    blobs: options.blobs,
    hasher: options.hasher,
    clock: options.clock,
  });
  return createHistoryReader({
    events: options.events,
    artifacts,
    authorize,
    redactDeniedEvidence,
    digest(value) {
      const hash = options.hasher.create();
      hash.update(typeof value === "string" ? new TextEncoder().encode(value) : value);
      return String(hash.digest());
    },
  });
}
