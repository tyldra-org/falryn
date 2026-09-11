/** Checkpoints use the existing SQLite writer and runtime journal, with atomic revision guards. */
import { canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import {
  configurationGeneration,
  eventId,
  idempotencyKey,
  sequence,
  sessionId,
  streamId,
  timestampFromEpochMilliseconds,
  traceId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../../domain/foundation/limits.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { RESOURCE_DIMENSIONS } from "../../domain/orchestration/resource-admission.ts";
import { WORKFLOW_LIMITS } from "../../domain/orchestration/workflow-definition.ts";
import {
  validWorkflowTransition,
  type WorkflowHandle,
  type WorkflowReceipt,
  type WorkflowRecord,
  type WorkflowResult,
  type WorkflowStore,
  workflowHandleSchema,
  workflowRecordSchema,
} from "../../domain/orchestration/workflow-state.ts";
import { fromStoredEvent } from "../../domain/sessions/stored-event.ts";
import type { Migration, SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";
import { appendRuntimeEventInTransaction } from "../sessions/event-store.ts";

export const WORKFLOW_TABLES = ["workflow_runs", "workflow_revisions"] as const;
export const MIGRATION_0022: Migration = {
  version: 22,
  name: "workflow-checkpoints",
  destructive: false,
  statements: [
    "CREATE TABLE workflow_runs (id TEXT NOT NULL, generation TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(id,generation)) STRICT",
    "CREATE INDEX workflow_owner_runs ON workflow_runs(workspace_id,session_id,id,generation)",
    "CREATE TABLE workflow_revisions (id TEXT NOT NULL, generation TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 4194304), PRIMARY KEY(id,generation,revision), FOREIGN KEY(id,generation) REFERENCES workflow_runs(id,generation)) STRICT",
  ],
};
const stream = (handle: WorkflowHandle) => `workflow:${canonicalDigest(handle).slice(7)}`;
const immutable = (record: WorkflowRecord) =>
  canonicalDigest({
    handle: record.handle,
    intent: record.intent,
    definition: record.definition,
    definitionDigest: record.definitionDigest,
    arguments: record.arguments,
    owner: record.owner,
    authority: record.authority,
    sourceGeneration: record.sourceGeneration,
    routes: record.routes,
    createdAt: record.createdAt,
    deadline: record.deadline,
    limits: record.limits,
    reusedFrom: record.reusedFrom,
  });

export function createWorkflowStore(store: SqliteStorePort): WorkflowStore {
  function write<T>(work: (sql: SqliteStatements) => WorkflowResult<T>, signal?: AbortSignal) {
    const result = store.write(work, signal);
    return result.ok
      ? result.value.value
      : err({
          code:
            result.error.effect === "uncertain"
              ? "recovery-required"
              : result.error.code === "cancelled"
                ? "cancelled"
                : "storage-unavailable",
        });
  }
  function load(
    sql: Pick<SqliteStatements, "all">,
    handle: WorkflowHandle,
    revision?: number,
  ): WorkflowResult<WorkflowRecord> {
    const current = sql.all(
      "SELECT * FROM workflow_runs WHERE id=$id AND generation=$generation",
      handle,
    )[0];
    if (!current) return err({ code: "not-found" });
    const at = revision ?? Number(current.revision);
    const row = sql.all(
      "SELECT * FROM workflow_revisions WHERE id=$id AND generation=$generation AND revision=$revision",
      { ...handle, revision: at },
    )[0];
    try {
      if (
        !row ||
        typeof row.record !== "string" ||
        Buffer.byteLength(row.record) > WORKFLOW_LIMITS.checkpointBytes
      )
        return err({ code: "corrupt" });
      const parsed = workflowRecordSchema.safeParse(JSON.parse(row.record));
      if (!parsed.success) return err({ code: "corrupt" });
      const record = parsed.data;
      if (
        record.handle.id !== handle.id ||
        record.handle.generation !== handle.generation ||
        record.revision !== at ||
        record.owner.workspaceId !== current.workspace_id ||
        record.owner.sessionId !== current.session_id ||
        canonicalDigest(record) !== row.digest ||
        canonicalDigest(record.definition) !== record.definitionDigest
      )
        return err({ code: "corrupt" });
      const event = sql.all("SELECT * FROM events WHERE stream_id=$stream AND sequence=$revision", {
        stream: stream(handle),
        revision: at,
      })[0];
      if (!event || typeof event.payload !== "string" || Buffer.byteLength(event.payload) > 4096)
        return err({ code: "corrupt" });
      const decoded = fromStoredEvent({
        eventId: eventId.from(String(event.event_id)),
        aggregateId: String(event.stream_id),
        sequence: Number(event.sequence),
        kind: String(event.kind),
        schemaVersion: Number(event.schema_version),
        occurredAt: String(event.occurred_at),
        traceId: traceId.from(String(event.trace_id)),
        payload: JSON.parse(event.payload),
      });
      if (
        !decoded.ok ||
        decoded.value.kind !== "workflow.changed" ||
        decoded.value.correlation.workspaceId !== record.owner.workspaceId ||
        decoded.value.correlation.sessionId !== record.owner.sessionId ||
        decoded.value.correlation.configurationGeneration !==
          record.owner.configurationGeneration ||
        canonicalJson(decoded.value.payload) !== canonicalJson(receiptFor(record))
      )
        return err({ code: "corrupt" });
      return ok(record);
    } catch {
      return err({ code: "corrupt" });
    }
  }
  function receiptFor(record: WorkflowRecord) {
    return {
      version: 1 as const,
      handle: record.handle,
      revision: record.revision,
      digest: canonicalDigest(record),
      definitionDigest: record.definitionDigest,
      state: record.state,
      at: record.updatedAt,
    };
  }
  function save(sql: SqliteStatements, record: WorkflowRecord) {
    const receipt = receiptFor(record);
    sql.run(
      "INSERT INTO workflow_revisions(id,generation,revision,digest,record) VALUES($id,$generation,$revision,$digest,$record)",
      {
        ...record.handle,
        revision: record.revision,
        digest: receipt.digest,
        record: canonicalJson(record),
      },
    );
    sql.run("UPDATE workflow_runs SET revision=$revision WHERE id=$id AND generation=$generation", {
      ...record.handle,
      revision: record.revision,
    });
    const identity = `${stream(record.handle)}:${record.revision}`;
    const result = appendRuntimeEventInTransaction(sql, {
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: eventId.from(identity),
      streamId: streamId.from(stream(record.handle)),
      sequence: sequence.from(record.revision),
      occurredAt: timestampFromEpochMilliseconds(record.updatedAt),
      correlation: {
        sessionId: sessionId.from(record.owner.sessionId),
        workspaceId: workspaceId.from(record.owner.workspaceId),
        traceId: traceId.from(identity),
        configurationGeneration: configurationGeneration.from(record.owner.configurationGeneration),
      },
      idempotencyKey: idempotencyKey.from(identity),
      kind: "workflow.changed",
      payload: receipt,
    });
    if (!result.ok || result.value.kind !== "appended")
      throw new Error("workflow-journal-conflict");
  }
  function valid(record: WorkflowRecord): boolean {
    return (
      Buffer.byteLength(canonicalJson(record)) <= WORKFLOW_LIMITS.checkpointBytes &&
      workflowRecordSchema.safeParse(record).success &&
      canonicalDigest(record.definition) === record.definitionDigest &&
      new Set(record.nodes.map((node) => node.key)).size === record.nodes.length
    );
  }
  return {
    create(record, signal) {
      if (!valid(record) || record.revision !== 1) return err({ code: "invalid-record" });
      return write((sql) => {
        const prior = load(sql, record.handle);
        if (prior.ok)
          return prior.value.intent === record.intent
            ? prior
            : err({ code: "conflicting-identity" });
        if (prior.error.code !== "not-found") return prior;
        sql.run(
          "INSERT INTO workflow_runs(id,generation,workspace_id,session_id,revision) VALUES($id,$generation,$workspace,$session,1)",
          {
            ...record.handle,
            workspace: record.owner.workspaceId,
            session: record.owner.sessionId,
          },
        );
        save(sql, record);
        return ok(record);
      }, signal);
    },
    get(handle, revision) {
      return write((sql) => load(sql, handle, revision));
    },
    change(handle, expectedRevision, update, signal) {
      return write((sql) => {
        const current = load(sql, handle);
        if (!current.ok) return current;
        if (current.value.revision !== expectedRevision)
          return err({ code: "stale-revision", currentRevision: current.value.revision });
        const next = update(current.value);
        if (!next.ok) return next;
        if (
          !valid(next.value) ||
          !validWorkflowTransition(current.value, next.value) ||
          next.value.revision !== expectedRevision + 1 ||
          immutable(next.value) !== immutable(current.value) ||
          next.value.updatedAt < current.value.updatedAt ||
          RESOURCE_DIMENSIONS.some(
            (dimension) =>
              (next.value.spent[dimension] ?? 0) < (current.value.spent[dimension] ?? 0),
          )
        )
          return err({ code: "invalid-transition" });
        save(sql, next.value);
        return next;
      }, signal);
    },
    page(workspace, session, after) {
      if (after !== undefined && !workflowHandleSchema.safeParse(after).success)
        return err({ code: "invalid-handle" });
      const result = write((sql) => {
        const rows = sql.all(
          "SELECT id,generation FROM workflow_runs WHERE workspace_id=$workspace AND session_id=$session AND (id,generation)>($id,$generation) ORDER BY id,generation LIMIT 50",
          { workspace, session, id: after?.id ?? "", generation: after?.generation ?? "" },
        );
        const records: WorkflowReceipt[] = [];
        for (const row of rows) {
          const record = load(sql, { id: String(row.id), generation: String(row.generation) });
          if (!record.ok) return record;
          records.push(receiptFor(record.value));
        }
        return ok(records);
      });
      return result;
    },
  };
}
