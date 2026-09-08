/** Row validation and event writes shared by the task repository's transactions. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  configurationGeneration,
  err,
  eventId,
  idempotencyKey,
  ok,
  type Result,
  sequence,
  sessionId,
  streamId,
  timestampFromEpochMilliseconds,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../../domain/foundation/limits.ts";
import {
  type ProcessTaskHandle,
  type ProcessTaskSnapshot,
  processTaskSnapshotSchema,
} from "../../domain/orchestration/process-task.ts";
import type {
  ProcessTaskStoreError,
  ProcessTaskWake,
  ProcessTaskWrite,
} from "../../domain/orchestration/process-task-store.ts";
import type { ProcessTaskChangedEvent } from "../../domain/sessions/event.ts";
import type { SqliteRow, SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";
import { appendRuntimeEventInTransaction } from "../sessions/event-store.ts";
import { PROCESS_TASK_WAKES_TABLE, PROCESS_TASKS_TABLE } from "./process-task-schema.ts";

export const taskKey = (handle: ProcessTaskHandle) => ({
  taskId: handle.taskId,
  generation: handle.generation,
});
export const taskStream = (handle: ProcessTaskHandle) =>
  `process-task:${createHash("sha256")
    .update(JSON.stringify([handle.taskId, handle.generation]))
    .digest("hex")}`;

export function taskFailure(
  code: ProcessTaskStoreError["code"],
): Result<never, ProcessTaskStoreError> {
  return err({ code });
}

export function readTaskRow(
  row: SqliteRow | undefined,
  handle?: ProcessTaskHandle,
): Result<ProcessTaskSnapshot, ProcessTaskStoreError> {
  if (row === undefined) return taskFailure("not-found");
  if (
    typeof row.snapshot !== "string" ||
    new TextEncoder().encode(row.snapshot).byteLength > 16_384
  )
    return taskFailure("invalid-record");
  let input: unknown;
  try {
    input = JSON.parse(row.snapshot);
  } catch {
    return taskFailure("invalid-record");
  }
  const parsed = processTaskSnapshotSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.revision !== row.revision ||
    parsed.data.handle.taskId !== row.task_id ||
    parsed.data.handle.generation !== row.generation
  )
    return taskFailure("invalid-record");
  if (
    handle !== undefined &&
    (handle.taskId !== row.task_id || handle.generation !== row.generation)
  )
    return taskFailure("stale-generation");
  return ok(parsed.data);
}

const taskEventPayload = z.strictObject({
  change: z.enum([
    "created",
    "started",
    "attachment",
    "settling",
    "sealed",
    "reconciled",
    "cleaned",
  ]),
  task: processTaskSnapshotSchema,
});

export function readTaskEvent(
  row: SqliteRow | undefined,
): Result<z.infer<typeof taskEventPayload>, ProcessTaskStoreError> {
  if (
    row?.kind !== "process.task.changed" ||
    typeof row.payload !== "string" ||
    row.payload.length > 32_768
  )
    return taskFailure("invalid-record");
  let raw: unknown;
  try {
    raw = JSON.parse(row.payload);
  } catch {
    return taskFailure("invalid-record");
  }
  const parsed = z.object({ payload: taskEventPayload }).safeParse(raw);
  if (!parsed.success || row.sequence !== parsed.data.payload.task.revision)
    return taskFailure("invalid-record");
  return ok(parsed.data.payload);
}

/** Rebuild the lifecycle from its semantic event; only lease renewal is nonsemantic. */
export function verifyTaskEvent(
  task: ProcessTaskSnapshot,
  row: SqliteRow | undefined,
): Result<ProcessTaskSnapshot, ProcessTaskStoreError> {
  const parsed = readTaskEvent(row);
  if (!parsed.ok) return parsed;
  if (parsed.value.change === "cleaned") return taskFailure("invalid-record");
  const eventTask = parsed.value.task;
  const rebuilt = {
    ...eventTask,
    supervisor: { ...eventTask.supervisor, leaseExpiresAt: task.supervisor.leaseExpiresAt },
  };
  if (
    eventTask.supervisor.leaseExpiresAt > task.supervisor.leaseExpiresAt ||
    JSON.stringify(rebuilt) !== JSON.stringify(task)
  )
    return taskFailure("invalid-record");
  return ok(rebuilt);
}

export function loadTask(statements: SqliteStatements, handle: ProcessTaskHandle) {
  return readTaskRow(
    statements.all(`SELECT * FROM ${PROCESS_TASKS_TABLE} WHERE task_id = $taskId`, {
      taskId: handle.taskId,
    })[0],
    handle,
  );
}

export function writeTask<Value>(
  store: SqliteStorePort,
  work: (statements: SqliteStatements) => Result<Value, ProcessTaskStoreError>,
  signal?: AbortSignal,
): Result<ProcessTaskWrite<Value>, ProcessTaskStoreError> {
  const written = store.write(work, signal);
  if (!written.ok)
    return taskFailure(written.error.code === "cancelled" ? "cancelled" : "storage-unavailable");
  return written.value.value.ok
    ? ok({
        value: written.value.value.value,
        cancelledAfterCommit: written.value.cancelledAfterCommit,
      })
    : written.value.value;
}

export function appendTaskEvent(
  statements: SqliteStatements,
  task: ProcessTaskSnapshot,
  change: ProcessTaskChangedEvent["payload"]["change"],
  now: number,
): Result<string, ProcessTaskStoreError> {
  const stream = taskStream(task.handle);
  const identity = `${stream}:${task.revision}`;
  const event: ProcessTaskChangedEvent = {
    eventId: eventId.from(identity),
    streamId: streamId.from(stream),
    sequence: sequence.from(task.revision),
    idempotencyKey: idempotencyKey.from(identity),
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    occurredAt: timestampFromEpochMilliseconds(now),
    kind: "process.task.changed",
    correlation: {
      sessionId: sessionId.from(task.owner.sessionId),
      workspaceId: workspaceId.from(task.owner.workspaceId),
      turnId: turnId.from(task.owner.turnId),
      configurationGeneration: configurationGeneration.from(task.owner.configurationGeneration),
      traceId: traceId.from(stream),
    },
    payload: { change, task },
  };
  const appended = appendRuntimeEventInTransaction(statements, event);
  return appended.ok && appended.value.kind === "appended"
    ? ok(identity)
    : taskFailure("event-rejected");
}

export function updateTaskRow(statements: SqliteStatements, task: ProcessTaskSnapshot): void {
  statements.run(
    "UPDATE process_tasks SET revision = $revision, snapshot = $snapshot WHERE task_id = $taskId AND generation = $generation",
    { ...taskKey(task.handle), revision: task.revision, snapshot: JSON.stringify(task) },
  );
}

export function readWakeRow(
  row: SqliteRow | undefined,
  handle: ProcessTaskHandle,
): Result<ProcessTaskWake, ProcessTaskStoreError> {
  if (row === undefined) return taskFailure("notification-unavailable");
  if (
    typeof row.notification_id !== "string" ||
    row.notification_id.length > 128 ||
    typeof row.terminal_event_id !== "string" ||
    row.terminal_event_id.length > 128 ||
    !Number.isSafeInteger(row.attempts) ||
    typeof row.attempts !== "number" ||
    row.attempts < 0 ||
    row.attempts > 3 ||
    (row.state !== "pending" && row.state !== "acknowledged" && row.state !== "unavailable")
  )
    return taskFailure("invalid-record");
  return ok({
    handle,
    notificationId: row.notification_id,
    terminalEventId: row.terminal_event_id,
    attempts: row.attempts,
    state: row.state,
  });
}

export function loadWake(statements: SqliteStatements, handle: ProcessTaskHandle) {
  return readWakeRow(
    statements.all(
      `SELECT * FROM ${PROCESS_TASK_WAKES_TABLE} WHERE task_id = $taskId AND generation = $generation`,
      taskKey(handle),
    )[0],
    handle,
  );
}
