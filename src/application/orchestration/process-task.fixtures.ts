import { createArtifactRepository } from "../../data/artifacts/artifact-repository.ts";
import { createArtifactStore } from "../../data/artifacts/artifact-store.ts";
import { openProductStoreOrThrow, temporaryRoot } from "../../data/fixtures.ts";
import { createSqliteProcessTaskStore } from "../../data/orchestration/process-task-store.ts";
import { createSqliteEventStore } from "../../data/sessions/event-store.ts";
import { createInMemoryBlobStore } from "../../domain/artifacts/index.ts";
import {
  capabilityInvocationStarted,
  processTaskChanged,
  sessionStarted,
  turnStarted,
} from "../../domain/fixtures.ts";
import { createManualClock, type Result, runId } from "../../domain/foundation/index.ts";
import { createSha256Hasher } from "../../integrations/filesystem/content-digest.ts";

export function taskValue<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(`task fixture failure: ${JSON.stringify(result.error)}`);
  return result.value;
}

export async function createProcessTaskFixture(seedInvocation = true) {
  const database = await openProductStoreOrThrow(await temporaryRoot("falryn-process-task-app-"));
  const events = createSqliteEventStore(database, { projectStartedRecords: true });
  for (const event of [
    sessionStarted(1),
    turnStarted(2),
    ...(seedInvocation
      ? [
          {
            ...capabilityInvocationStarted(3),
            payload: { capabilityVersion: 1, inputDigest: "a".repeat(64) },
          },
        ]
      : []),
  ])
    taskValue(await events.append(event));
  taskValue(
    database.write((sql) =>
      sql.run(
        "INSERT INTO runs (run_id, started_at, ended_at, schema_version) VALUES ('run-task-fixture', '2026-07-31T12:00:00.000Z', NULL, 3)",
      ),
    ),
  );
  const clock = createManualClock();
  const blobs = createInMemoryBlobStore();
  const artifacts = createArtifactStore({
    repository: createArtifactRepository(database, runId.from("run-task-fixture")),
    blobs,
    hasher: createSha256Hasher(),
    clock,
  });
  return {
    database,
    events,
    clock,
    blobs,
    artifacts,
    tasks: createSqliteProcessTaskStore(database),
    snapshot: processTaskChanged().payload.task,
    async close() {
      await artifacts.quiesce();
      await database.close();
    },
  };
}
