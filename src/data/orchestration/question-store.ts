import { createHash } from "node:crypto";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  PROCESS_TASK_LEASE_MS,
  type ProcessTaskSnapshot,
} from "../../domain/orchestration/process-task.ts";
import {
  QUESTION_LIMITS,
  type QuestionRecord,
  type QuestionResult,
  type QuestionStore,
  questionRecordSchema,
} from "../../domain/orchestration/question.ts";
import type { ProcessBirthIdentity } from "../../domain/process/process-identity.ts";
import type { Migration, SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";
import {
  appendTaskEvent,
  loadTask,
  readTaskRow,
  taskKey,
  taskStream,
  updateTaskRow,
  verifyTaskEvent,
} from "./process-task-records.ts";

export const QUESTION_TABLES = ["question_requests", "question_revisions"] as const;
export const MIGRATION_0015: Migration = {
  version: 15,
  name: "durable-structured-questions",
  destructive: false,
  statements: [
    "CREATE TABLE question_requests (task_id TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL, owner_key TEXT NOT NULL, owner_identity TEXT NOT NULL, expires_at INTEGER NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0,1))) STRICT",
    "CREATE INDEX question_owner_requests ON question_requests(owner_identity, terminal)",
    "CREATE TABLE question_revisions (task_id TEXT NOT NULL REFERENCES question_requests(task_id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 64), record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 65536), PRIMARY KEY(task_id,revision)) STRICT",
  ],
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownerIdentity = (record: QuestionRecord) =>
  digest([record.owner.sessionId, record.owner.resourceTaskId, record.owner.generation]);

/** Question semantic revisions and #157 task events/wakes commit under the same writer. */
export function createQuestionStore(
  store: SqliteStorePort,
  supervisor: { runId: string; process: ProcessBirthIdentity | null },
): QuestionStore {
  function write<T>(
    work: (sql: SqliteStatements) => QuestionResult<T>,
    signal?: AbortSignal,
  ): QuestionResult<T> {
    const result = store.write(work, signal);
    return result.ok
      ? result.value.value
      : err({
          code:
            result.error.effect === "uncertain"
              ? "uncertain"
              : result.error.code === "cancelled"
                ? "cancelled"
                : "storage-unavailable",
        });
  }
  function load(
    sql: Pick<SqliteStatements, "all">,
    handle: QuestionRecord["input"]["handle"],
  ): QuestionResult<QuestionRecord> {
    const row = sql.all(
      "SELECT q.*, r.record FROM question_requests q JOIN question_revisions r ON r.task_id=q.task_id AND r.revision=q.revision WHERE q.task_id=$taskId",
      { taskId: handle.taskId },
    )[0];
    if (row === undefined) return err({ code: "not-found" });
    try {
      if (typeof row.record !== "string" || Buffer.byteLength(row.record) > 65_536)
        return err({ code: "corrupt" });
      const parsed = questionRecordSchema.safeParse(JSON.parse(row.record));
      if (!parsed.success) return err({ code: "corrupt" });
      const record = parsed.data;
      if (
        record.input.handle.taskId !== row.task_id ||
        record.input.handle.generation !== row.generation ||
        record.revision !== row.revision ||
        record.ownerKey !== row.owner_key ||
        record.intent !== digest([record.owner, record.input]) ||
        ownerIdentity(record) !== row.owner_identity ||
        record.expiresAt !== row.expires_at ||
        Number(record.settlement !== null) !== row.terminal
      )
        return err({ code: "corrupt" });
      if (handle.generation !== record.input.handle.generation)
        return err({ code: "stale-generation" });
      const task = readTaskRow(
        sql.all("SELECT * FROM process_tasks WHERE task_id=$taskId", { taskId: handle.taskId })[0],
        handle,
      );
      if (!task.ok) return err({ code: "corrupt" });
      const event = sql.all(
        "SELECT kind,payload,sequence FROM events WHERE stream_id=$stream AND sequence=$revision",
        { stream: taskStream(handle), revision: record.revision },
      )[0];
      if (
        !verifyTaskEvent(task.value, event).ok ||
        JSON.stringify({ ...taskFor(record), supervisor: task.value.supervisor }) !==
          JSON.stringify(task.value)
      )
        return err({ code: "corrupt" });
      return ok(record);
    } catch {
      return err({ code: "corrupt" });
    }
  }
  function save(sql: SqliteStatements, record: QuestionRecord) {
    sql.run(
      "INSERT INTO question_revisions(task_id,revision,record) VALUES($taskId,$revision,$record)",
      {
        taskId: record.input.handle.taskId,
        revision: record.revision,
        record: JSON.stringify(record),
      },
    );
    sql.run(
      "UPDATE question_requests SET revision=$revision,terminal=$terminal WHERE task_id=$taskId",
      {
        taskId: record.input.handle.taskId,
        revision: record.revision,
        terminal: Number(record.settlement !== null),
      },
    );
  }
  function taskFor(record: QuestionRecord, existing?: ProcessTaskSnapshot): ProcessTaskSnapshot {
    const base = existing ?? {
      executionKind: "question" as const,
      handle: record.input.handle,
      revision: 1,
      owner: {
        sessionId: record.owner.sessionId,
        workspaceId: record.owner.workspaceId,
        turnId: record.owner.turnId,
        invocationId: record.owner.invocationId,
        attemptId: record.owner.attemptId,
        configurationGeneration: record.owner.configurationGeneration,
        resourceTaskId: record.owner.resourceTaskId,
      },
      supervisor: { ...supervisor, leaseExpiresAt: record.createdAt + PROCESS_TASK_LEASE_MS },
      attachment: "background" as const,
      createdAt: record.createdAt,
      deadline: record.expiresAt,
      inputDigest: record.intent,
      outputMode: "raw" as const,
      state: "queued" as const,
      process: null,
      terminal: null,
    };
    if (record.settlement === null)
      return { ...base, revision: record.revision, state: "queued", process: null, terminal: null };
    const kind = record.settlement.kind;
    return {
      ...base,
      revision: record.revision,
      state: "terminal",
      process: null,
      terminal: {
        outcome:
          kind === "answered"
            ? "completed"
            : kind === "expired"
              ? "timed-out"
              : kind === "cancelled" || kind === "refused"
                ? "cancelled"
                : "failed",
        effect: "none",
        reason: "question-settled",
        exitCode: null,
        signal: null,
        sealedAt: record.settlement.at,
        result: null,
      },
    };
  }
  const readSql: Pick<SqliteStatements, "all"> = {
    all(sql, bindings) {
      const result = store.read(sql, bindings);
      if (!result.ok) throw new Error("storage-unavailable");
      return [...result.value];
    },
  };
  return {
    create(record, signal) {
      if (
        !questionRecordSchema.safeParse(record).success ||
        record.state !== "created" ||
        record.revision !== 1
      )
        return err({ code: "malformed" });
      return write((sql) => {
        if (
          sql.all("SELECT event_id FROM events WHERE stream_id=$stream LIMIT 1", {
            stream: taskStream(record.input.handle),
          }).length ||
          sql.all("SELECT task_id FROM process_tasks WHERE task_id=$taskId", {
            taskId: record.input.handle.taskId,
          }).length
        )
          return err({ code: "stale-generation" });
        const counts = sql.all(
          "SELECT terminal,count(*) AS count FROM question_requests WHERE owner_identity=$owner GROUP BY terminal",
          { owner: ownerIdentity(record) },
        );
        if (
          Number(sql.all("SELECT count(*) AS count FROM process_tasks")[0]?.count) >= 256 ||
          counts.reduce((total, row) => total + Number(row.count), 0) >=
            QUESTION_LIMITS.retainedPerOwner ||
          counts.some((r) => r.terminal === 0 && Number(r.count) >= QUESTION_LIMITS.activePerOwner)
        )
          return err({ code: "resource-exhausted" });
        const task = taskFor(record);
        const event = appendTaskEvent(sql, task, "created", record.createdAt);
        if (!event.ok) throw new Error(event.error.code);
        sql.run(
          "INSERT INTO process_tasks(task_id,generation,revision,snapshot) VALUES($taskId,$generation,1,$snapshot)",
          { ...taskKey(task.handle), snapshot: JSON.stringify(task) },
        );
        sql.run(
          "INSERT INTO question_requests(task_id,generation,revision,owner_key,owner_identity,expires_at,terminal) VALUES($taskId,$generation,1,$ownerKey,$owner,$expiry,0)",
          {
            ...taskKey(task.handle),
            ownerKey: record.ownerKey,
            owner: ownerIdentity(record),
            expiry: record.expiresAt,
          },
        );
        save(sql, record);
        return ok(record);
      }, signal);
    },
    change(handle, update, signal) {
      return write((sql) => {
        const loaded = load(sql, handle);
        if (!loaded.ok) return loaded;
        const next = update(loaded.value);
        if (!next.ok) return next;
        if (JSON.stringify(next.value) === JSON.stringify(loaded.value)) return loaded;
        const record = next.value;
        if (
          !questionRecordSchema.safeParse(record).success ||
          record.revision !== loaded.value.revision + 1 ||
          record.revision > 64 ||
          record.ownerKey !== loaded.value.ownerKey ||
          record.presenterKey !== loaded.value.presenterKey ||
          record.intent !== loaded.value.intent ||
          JSON.stringify(record.input) !== JSON.stringify(loaded.value.input) ||
          record.expiresAt !== loaded.value.expiresAt ||
          JSON.stringify(record.owner) !== JSON.stringify(loaded.value.owner) ||
          loaded.value.settlement !== null
        )
          return err({ code: "invalid-transition" });
        const loadedTask = loadTask(sql, handle);
        if (
          !loadedTask.ok ||
          loadedTask.value.executionKind !== "question" ||
          loadedTask.value.revision !== loaded.value.revision ||
          loadedTask.value.state === "terminal"
        )
          return err({ code: "corrupt" });
        const task = taskFor(record, loadedTask.value);
        const event = appendTaskEvent(
          sql,
          task,
          record.settlement === null ? "attachment" : "sealed",
          record.settlement?.at ?? record.createdAt,
        );
        if (!event.ok) throw new Error(event.error.code);
        save(sql, record);
        updateTaskRow(sql, task);
        if (record.settlement !== null)
          sql.run(
            "INSERT INTO process_task_wakes(task_id,generation,notification_id,terminal_event_id) VALUES($taskId,$generation,$notification,$event)",
            { ...taskKey(handle), notification: `wake:${event.value}`, event: event.value },
          );
        return ok(record);
      }, signal);
    },
    get(handle) {
      try {
        return load(readSql, handle);
      } catch {
        return err({ code: "storage-unavailable" });
      }
    },
    active() {
      try {
        const rows = readSql.all(
          "SELECT task_id,generation FROM question_requests WHERE terminal=0 ORDER BY expires_at LIMIT 257",
        );
        if (rows.length > 256) return err({ code: "resource-exhausted" });
        const records: QuestionRecord[] = [];
        for (const row of rows) {
          if (typeof row.task_id !== "string" || typeof row.generation !== "string")
            return err({ code: "corrupt" });
          const r = load(readSql, { version: 1, taskId: row.task_id, generation: row.generation });
          if (!r.ok) return r;
          records.push(r.value);
        }
        return ok(records);
      } catch {
        return err({ code: "storage-unavailable" });
      }
    },
    cleanup(ownerKey, before, signal) {
      return write((sql) => {
        const rows = sql.all(
          "SELECT q.task_id,q.generation FROM question_requests q JOIN process_task_wakes w ON w.task_id=q.task_id AND w.generation=q.generation WHERE q.owner_key=$key AND q.terminal=1 AND q.expires_at<=$before AND w.state='acknowledged' LIMIT 64",
          { key: ownerKey, before },
        );
        for (const row of rows) {
          sql.run("DELETE FROM question_requests WHERE task_id=$id", { id: String(row.task_id) });
          sql.run("DELETE FROM process_tasks WHERE task_id=$id AND generation=$generation", {
            id: String(row.task_id),
            generation: String(row.generation),
          });
        }
        return ok(rows.length);
      }, signal);
    },
  };
}
