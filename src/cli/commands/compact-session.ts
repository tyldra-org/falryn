/** Bind the checkpoint action to an existing local session and its authorized artifacts. */
import {
  type CheckpointOutcome,
  type CheckpointRequest,
  createProductCheckpointAction,
} from "../../application/compression/product-checkpoint.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createRecordRepositories, createSqliteEventStore } from "../../data/index.ts";
import type { CheckpointAuthority } from "../../domain/compression/history-projection.ts";
import { configurationGeneration, sessionId, traceId } from "../../domain/foundation/index.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { openArtifactStore } from "./storage.ts";

export async function runStoredCheckpoint(
  services: ServiceProvider,
  session: string,
  request: CheckpointRequest,
  authority: () => CheckpointAuthority | null,
  signal: AbortSignal,
): Promise<CheckpointOutcome> {
  const fail = (reason: string): CheckpointOutcome => ({ kind: "refused", reason, effect: "none" });
  const opened = await openArtifactStore(
    services,
    signal,
    request.action === "inspect" ? "read" : "write",
  );
  if (!opened.ok || opened.kind === "absent") return fail("session-storage-unavailable");
  const resources = processProductResources.openTask(
    String(authority()?.configurationGeneration ?? 0),
  );
  try {
    const sessions = createRecordRepositories(opened.store).sessions;
    const record = sessions.get(sessionId.from(session));
    if (!record.ok || !record.value) return fail("session-missing");
    const correlation = {
      sessionId: record.value.sessionId,
      workspaceId: record.value.workspaceId,
      traceId: traceId.from(`compact-${session}`),
      configurationGeneration: configurationGeneration.from(
        authority()?.configurationGeneration ?? Number(record.value.configurationGeneration),
      ),
    };
    const events = createSqliteEventStore(opened.store);
    return await createProductCheckpointAction({
      events,
      artifacts: opened.artifacts,
      streamId: record.value.streamId,
      correlation,
      journal: createTurnEventJournal({
        eventStore: events,
        clock: services().clock,
        streamId: record.value.streamId,
        correlation,
      }),
      clock: services().clock,
      durable: true,
      settled: () => true,
      authority,
      authorize(event, artifact) {
        const current = sessions.get(correlation.sessionId);
        return (
          current.ok &&
          current.value !== null &&
          current.value.workspaceId === correlation.workspaceId &&
          event.correlation.sessionId === correlation.sessionId &&
          event.correlation.workspaceId === correlation.workspaceId &&
          (artifact === null ||
            artifact.sensitivity === "public" ||
            artifact.sensitivity === "user-content")
        );
      },
    }).run(request, resources, signal);
  } finally {
    resources.close();
    await opened.close();
  }
}
