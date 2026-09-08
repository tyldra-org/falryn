/** Output reference admission and bounded durable notification attempts. Never reads output bytes. */
import { z } from "zod";
import { ok } from "../../domain/foundation/index.ts";
import {
  MAX_PROCESS_TASK_WAKE_ATTEMPTS,
  processTaskArtifactSchema,
  processTaskHandleSchema,
} from "../../domain/orchestration/process-task.ts";
import type {
  ProcessTaskChunk,
  ProcessTaskStore,
} from "../../domain/orchestration/process-task-store.ts";
import { MAX_PROCESS_CAPTURE_BYTES } from "../../domain/process/process-capture.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { ownsTaskArtifact } from "./process-task-artifacts.ts";
import {
  loadTask,
  loadWake,
  readWakeRow,
  taskFailure,
  taskKey,
  writeTask,
} from "./process-task-records.ts";

const chunkSchema = z.strictObject({
  handle: processTaskHandleSchema,
  stream: z.enum(["stdout", "stderr"]),
  offset: z.int().nonnegative(),
  artifact: processTaskArtifactSchema,
});
const SELECT_CHUNKS =
  "SELECT offset, byte_length, artifact_id, digest FROM process_task_chunks WHERE task_id = $taskId AND generation = $generation AND stream = $stream ORDER BY offset LIMIT 257";
const SELECT_WAKE =
  "SELECT * FROM process_task_wakes WHERE task_id = $taskId AND generation = $generation";

export function processTaskOutputAccess(
  store: SqliteStorePort,
): Pick<ProcessTaskStore, "appendChunk" | "chunks" | "wake" | "claimWake" | "acknowledgeWake"> {
  return {
    appendChunk(fence, input, now, signal) {
      const parsed = chunkSchema.safeParse(input);
      if (!parsed.success) return taskFailure("invalid-record");
      const chunk = parsed.data;
      if (
        chunk.handle.taskId !== fence.handle.taskId ||
        chunk.handle.generation !== fence.handle.generation ||
        chunk.artifact.byteLength < 1 ||
        chunk.artifact.byteLength > 65_536 ||
        chunk.offset + chunk.artifact.byteLength > MAX_PROCESS_CAPTURE_BYTES
      )
        return taskFailure("invalid-record");
      return writeTask(
        store,
        (statements) => {
          const loaded = loadTask(statements, fence.handle);
          if (!loaded.ok) return loaded;
          const task = loaded.value;
          if (task.revision !== fence.expectedRevision) return taskFailure("stale-revision");
          if (task.state === "terminal") return taskFailure("sealed");
          if (task.state === "queued") return taskFailure("invalid-transition");
          if (
            task.supervisor.runId !== fence.supervisorRunId ||
            now >= task.supervisor.leaseExpiresAt ||
            !Number.isSafeInteger(now) ||
            now < task.createdAt
          )
            return taskFailure("ownership-unavailable");
          if (!ownsTaskArtifact(statements, task.handle, chunk.artifact.artifactId))
            return taskFailure("invalid-record");
          const previous = statements.all(SELECT_CHUNKS, {
            ...taskKey(chunk.handle),
            stream: chunk.stream,
          });
          const duplicate = previous.find((row) => row.offset === chunk.offset);
          if (duplicate !== undefined)
            return duplicate.artifact_id === chunk.artifact.artifactId &&
              duplicate.digest === chunk.artifact.digest &&
              duplicate.byte_length === chunk.artifact.byteLength
              ? ok(null)
              : taskFailure("invalid-record");
          if (previous.length >= 256) return taskFailure("capacity");
          let next = 0;
          for (const row of previous) {
            if (row.offset !== next || typeof row.byte_length !== "number")
              return taskFailure("invalid-record");
            next += row.byte_length;
          }
          if (next !== chunk.offset) return taskFailure("invalid-record");
          const artifact = statements.all(
            "SELECT availability, digest, byte_length, invocation_id FROM artifacts WHERE artifact_id = $artifactId",
            { artifactId: chunk.artifact.artifactId },
          )[0];
          if (
            artifact?.availability !== "available" ||
            artifact.digest !== chunk.artifact.digest ||
            artifact.byte_length !== chunk.artifact.byteLength ||
            artifact.invocation_id !== task.owner.invocationId
          )
            return taskFailure("invalid-record");
          statements.run(
            "INSERT INTO process_task_chunks (task_id, generation, stream, offset, byte_length, artifact_id, digest) VALUES ($taskId, $generation, $stream, $offset, $byteLength, $artifactId, $digest)",
            {
              ...taskKey(chunk.handle),
              stream: chunk.stream,
              offset: chunk.offset,
              byteLength: chunk.artifact.byteLength,
              artifactId: chunk.artifact.artifactId,
              digest: chunk.artifact.digest,
            },
          );
          return ok(null);
        },
        signal,
      );
    },
    chunks(handle, stream) {
      const rows = store.read(SELECT_CHUNKS, { ...taskKey(handle), stream });
      if (!rows.ok) return taskFailure("storage-unavailable");
      if (rows.value.length > 256) return taskFailure("capacity");
      const chunks: ProcessTaskChunk[] = [];
      let next = 0;
      for (const row of rows.value) {
        const parsed = chunkSchema.safeParse({
          handle,
          stream,
          offset: row.offset,
          artifact: {
            artifactId: row.artifact_id,
            digest: row.digest,
            byteLength: row.byte_length,
          },
        });
        if (
          !parsed.success ||
          parsed.data.offset !== next ||
          parsed.data.artifact.byteLength < 1 ||
          parsed.data.artifact.byteLength > 65_536
        )
          return taskFailure("invalid-record");
        next += parsed.data.artifact.byteLength;
        if (next > MAX_PROCESS_CAPTURE_BYTES) return taskFailure("invalid-record");
        chunks.push(parsed.data);
      }
      return ok(chunks);
    },
    wake(handle) {
      const rows = store.read(SELECT_WAKE, taskKey(handle));
      return rows.ok ? readWakeRow(rows.value[0], handle) : taskFailure("storage-unavailable");
    },
    claimWake(handle, signal) {
      return writeTask(
        store,
        (statements) => {
          const loaded = loadWake(statements, handle);
          if (!loaded.ok) return loaded;
          const wake = loaded.value;
          if (wake.state !== "pending") return taskFailure("notification-unavailable");
          if (wake.attempts >= MAX_PROCESS_TASK_WAKE_ATTEMPTS) {
            statements.run(
              "UPDATE process_task_wakes SET state = 'unavailable' WHERE task_id = $taskId AND generation = $generation",
              taskKey(handle),
            );
            return taskFailure("notification-unavailable");
          }
          statements.run(
            "UPDATE process_task_wakes SET attempts = attempts + 1 WHERE task_id = $taskId AND generation = $generation",
            taskKey(handle),
          );
          return ok({ ...wake, attempts: wake.attempts + 1 });
        },
        signal,
      );
    },
    acknowledgeWake(handle, notificationId, signal) {
      return writeTask(
        store,
        (statements) => {
          const loaded = loadWake(statements, handle);
          if (!loaded.ok) return loaded;
          const wake = loaded.value;
          if (wake.notificationId !== notificationId || wake.attempts < 1)
            return taskFailure("notification-unavailable");
          statements.run(
            "UPDATE process_task_wakes SET state = 'acknowledged' WHERE task_id = $taskId AND generation = $generation",
            taskKey(handle),
          );
          return ok({ ...wake, state: "acknowledged" as const });
        },
        signal,
      );
    },
  };
}
