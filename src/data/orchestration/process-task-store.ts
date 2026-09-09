/** Fenced task transitions over the product SQLite store and existing event transaction rules. */
import { ok } from "../../domain/foundation/index.ts";
import {
  MAX_RETAINED_PROCESS_TASKS,
  PROCESS_TASK_LEASE_MS,
  PROCESS_TASK_LEASE_RENEWAL_MS,
  type ProcessTaskSnapshot,
  processTaskSnapshotSchema,
  transitionProcessTask,
} from "../../domain/orchestration/process-task.ts";
import type { ProcessTaskStore } from "../../domain/orchestration/process-task-store.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { pendingJoinReference } from "./agent-join-schema.ts";
import { ownsTaskArtifact } from "./process-task-artifacts.ts";
import { processTaskOutputAccess } from "./process-task-output.ts";
import {
  appendTaskEvent,
  loadTask,
  loadWake,
  readTaskEvent,
  readTaskRow,
  taskFailure,
  taskKey,
  taskStream,
  updateTaskRow,
  verifyTaskEvent,
  writeTask,
} from "./process-task-records.ts";

export function createSqliteProcessTaskStore(store: SqliteStorePort): ProcessTaskStore {
  return {
    ...processTaskOutputAccess(store),
    create(input, signal) {
      const parsed = processTaskSnapshotSchema.safeParse(input);
      if (
        !parsed.success ||
        parsed.data.state !== "queued" ||
        parsed.data.revision !== 1 ||
        parsed.data.supervisor.leaseExpiresAt !== parsed.data.createdAt + PROCESS_TASK_LEASE_MS ||
        parsed.data.deadline <= parsed.data.createdAt
      )
        return taskFailure("invalid-record");
      const task = parsed.data;
      return writeTask(
        store,
        (statements) => {
          if (
            statements.all("SELECT task_id FROM process_tasks WHERE task_id = $taskId", {
              taskId: task.handle.taskId,
            }).length > 0 ||
            statements.all("SELECT event_id FROM events WHERE stream_id = $stream LIMIT 1", {
              stream: taskStream(task.handle),
            }).length > 0
          )
            return taskFailure("stale-generation");
          const count = statements.all("SELECT COUNT(*) AS count FROM process_tasks")[0]?.count;
          if (typeof count !== "number" || count >= MAX_RETAINED_PROCESS_TASKS)
            return taskFailure("capacity");
          const event = appendTaskEvent(statements, task, "created", task.createdAt);
          if (!event.ok) return event;
          statements.run(
            "INSERT INTO process_tasks (task_id, generation, revision, snapshot) VALUES ($taskId, $generation, $revision, $snapshot)",
            { ...taskKey(task.handle), revision: task.revision, snapshot: JSON.stringify(task) },
          );
          return ok(task);
        },
        signal,
      );
    },
    get(handle) {
      const rows = store.read("SELECT * FROM process_tasks WHERE task_id = $taskId", {
        taskId: handle.taskId,
      });
      return rows.ok ? readTaskRow(rows.value[0], handle) : taskFailure("storage-unavailable");
    },
    cleaned(handle) {
      const rows = store.read(
        "SELECT kind, sequence, payload FROM events WHERE stream_id = $stream ORDER BY sequence DESC LIMIT 1",
        { stream: taskStream(handle) },
      );
      if (!rows.ok) return taskFailure("storage-unavailable");
      const event = readTaskEvent(rows.value[0]);
      if (!event.ok) return event;
      const task = event.value.task;
      return event.value.change === "cleaned" &&
        task.state === "terminal" &&
        task.handle.taskId === handle.taskId &&
        task.handle.generation === handle.generation
        ? ok(task)
        : taskFailure("not-found");
    },
    list() {
      const rows = store.read("SELECT * FROM process_tasks ORDER BY task_id LIMIT $limit", {
        limit: MAX_RETAINED_PROCESS_TASKS + 1,
      });
      if (!rows.ok) return taskFailure("storage-unavailable");
      if (rows.value.length > MAX_RETAINED_PROCESS_TASKS) return taskFailure("capacity");
      const tasks: ProcessTaskSnapshot[] = [];
      for (const row of rows.value) {
        const task = readTaskRow(row);
        if (!task.ok) return task;
        const event = store.read(
          "SELECT kind, sequence, payload FROM events WHERE stream_id = $stream ORDER BY sequence DESC LIMIT 1",
          { stream: taskStream(task.value.handle) },
        );
        if (!event.ok) return taskFailure("storage-unavailable");
        const rebuilt = verifyTaskEvent(task.value, event.value[0]);
        if (!rebuilt.ok) return rebuilt;
        tasks.push(rebuilt.value);
      }
      return ok(tasks);
    },
    transition(fence, change, now, signal) {
      return writeTask(
        store,
        (statements) => {
          const current = loadTask(statements, fence.handle);
          if (!current.ok) return current;
          const changed = transitionProcessTask(current.value, fence, change, now);
          if (!changed.ok) return taskFailure(changed.code);
          const validated = processTaskSnapshotSchema.safeParse(changed.value);
          if (!validated.success) return taskFailure("invalid-record");
          const task = validated.data;
          if (task.state === "terminal" && task.terminal.result !== null) {
            const result = task.terminal.result;
            const artifact = statements.all(
              "SELECT availability, digest, byte_length, invocation_id FROM artifacts WHERE artifact_id = $artifactId",
              { artifactId: result.artifactId },
            )[0];
            if (
              !ownsTaskArtifact(statements, task.handle, result.artifactId) ||
              artifact?.availability !== "available" ||
              artifact.digest !== result.digest ||
              artifact.byte_length !== result.byteLength ||
              artifact.invocation_id !== task.owner.invocationId
            )
              return taskFailure("invalid-record");
          }
          const event = appendTaskEvent(statements, task, change.kind, now);
          if (!event.ok) return event;
          updateTaskRow(statements, task);
          if (task.state === "terminal") {
            statements.run(
              "INSERT INTO process_task_wakes (task_id, generation, notification_id, terminal_event_id) VALUES ($taskId, $generation, $notificationId, $eventId)",
              {
                ...taskKey(task.handle),
                notificationId: `wake:${event.value}`,
                eventId: event.value,
              },
            );
          }
          return ok(task);
        },
        signal,
      );
    },
    renew(fence, now, signal) {
      return writeTask(
        store,
        (statements) => {
          const loaded = loadTask(statements, fence.handle);
          if (!loaded.ok) return loaded;
          const task = loaded.value;
          if (task.revision !== fence.expectedRevision) return taskFailure("stale-revision");
          if (task.state === "terminal") return taskFailure("sealed");
          if (
            task.supervisor.runId !== fence.supervisorRunId ||
            !Number.isSafeInteger(now) ||
            now >= task.supervisor.leaseExpiresAt ||
            now < task.createdAt
          )
            return taskFailure("ownership-unavailable");
          const lastRenewed = task.supervisor.leaseExpiresAt - PROCESS_TASK_LEASE_MS;
          if (now < lastRenewed + PROCESS_TASK_LEASE_RENEWAL_MS) return ok(task);
          const renewed = {
            ...task,
            supervisor: { ...task.supervisor, leaseExpiresAt: now + PROCESS_TASK_LEASE_MS },
          };
          updateTaskRow(statements, renewed);
          return ok(renewed);
        },
        signal,
      );
    },
    reconcile(expected, reason, now, signal) {
      return writeTask(
        store,
        (statements) => {
          const loaded = loadTask(statements, expected.handle);
          if (!loaded.ok) return loaded;
          const current = loaded.value;
          if (JSON.stringify(current) !== JSON.stringify(expected))
            return taskFailure("stale-revision");
          if (current.state === "terminal") return taskFailure("sealed");
          if (
            !Number.isSafeInteger(now) ||
            now < current.supervisor.leaseExpiresAt ||
            current.revision >= Number.MAX_SAFE_INTEGER
          )
            return taskFailure("ownership-unavailable");
          const task: ProcessTaskSnapshot = {
            ...current,
            revision: current.revision + 1,
            state: "terminal",
            terminal: {
              outcome: "uncertain",
              effect: "uncertain",
              reason,
              exitCode: null,
              signal: null,
              sealedAt: now,
              result: null,
              outputComplete: false,
            },
          };
          const event = appendTaskEvent(statements, task, "reconciled", now);
          if (!event.ok) return event;
          updateTaskRow(statements, task);
          statements.run(
            "INSERT INTO process_task_wakes (task_id, generation, notification_id, terminal_event_id) VALUES ($taskId, $generation, $notificationId, $eventId)",
            {
              ...taskKey(task.handle),
              notificationId: `wake:${event.value}`,
              eventId: event.value,
            },
          );
          return ok(task);
        },
        signal,
      );
    },
    cleanup(handle, expectedRevision, now, signal) {
      return writeTask(
        store,
        (statements) => {
          const loaded = loadTask(statements, handle);
          if (!loaded.ok) {
            if (
              loaded.error.code === "not-found" &&
              statements.all("SELECT event_id FROM events WHERE stream_id = $stream LIMIT 1", {
                stream: taskStream(handle),
              }).length > 0
            )
              return ok(null);
            return loaded;
          }
          const task = loaded.value;
          if (task.revision !== expectedRevision || task.revision >= Number.MAX_SAFE_INTEGER)
            return taskFailure("stale-revision");
          const wake = loadWake(statements, handle);
          if (task.state !== "terminal" || !wake.ok || wake.value.state === "pending")
            return taskFailure("busy");
          if (
            task.attachment === "foreground" &&
            statements.all(
              "SELECT 1 FROM agent_children c JOIN agent_parents p USING(owner) WHERE json_extract(c.record,'$.handle.task.taskId')=$taskId AND json_extract(c.record,'$.handle.task.generation')=$generation AND c.integrated=0 AND p.closed=0 LIMIT 1",
              task.handle,
            ).length > 0
          )
            return taskFailure("busy");
          if (!Number.isSafeInteger(now) || now < task.terminal.sealedAt)
            return taskFailure("invalid-record");
          if (
            statements.all(
              `SELECT 1 WHERE ${pendingJoinReference("$taskId", "$generation")}`,
              task.handle,
            ).length > 0
          )
            return taskFailure("busy");
          const event = appendTaskEvent(
            statements,
            { ...task, revision: task.revision + 1 },
            "cleaned",
            now,
          );
          if (!event.ok) return event;
          statements.run(
            "UPDATE process_task_artifacts SET released = 1 WHERE task_id = $taskId AND generation = $generation",
            taskKey(handle),
          );
          statements.run(
            "DELETE FROM process_tasks WHERE task_id = $taskId AND generation = $generation",
            taskKey(handle),
          );
          return ok(null);
        },
        signal,
      );
    },
  };
}
