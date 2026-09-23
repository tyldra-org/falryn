import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  configurationGeneration,
  err,
  eventId,
  idempotencyKey,
  ok,
  sequence,
  sessionId,
  streamId,
  timestampFromEpochMilliseconds,
  traceId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../../domain/foundation/limits.ts";
import { canonicalResourceValue } from "../../domain/orchestration/resource-admission.ts";
import {
  refuseWork,
  WORK_QUEUE_LIMITS,
  type WorkChild,
  type WorkGroup,
  type WorkItem,
  type WorkPlacement,
  type WorkQueueId,
  WorkQueueRefusal,
  type WorkQueueStore,
  type WorkQueueTransaction,
  type WorkReceipt,
  type WorkResult,
  workGroupSchema,
  workItemIdSchema,
  workItemSchema,
  workQueueIdSchema,
  workQueueSchema,
  workReceiptSchema,
} from "../../domain/orchestration/work-queue.ts";
import type { WorkQueueChangedEvent } from "../../domain/sessions/event.ts";
import type { SqliteRow, SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";
import { appendRuntimeEventInTransaction } from "../sessions/event-store.ts";

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalResourceValue(value)).digest("hex");
const queueStream = (id: WorkQueueId) => `work-queue:${digest(id)}`;
function decode<T>(row: SqliteRow | undefined, schema: z.ZodType<T>, maxBytes: number): T | null {
  if (row === undefined) return null;
  if (typeof row.record !== "string" || Buffer.byteLength(row.record) > maxBytes)
    refuseWork("corrupt");
  let value: unknown;
  try {
    value = JSON.parse(row.record);
  } catch {
    refuseWork("corrupt");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) refuseWork("corrupt");
  if (row.digest !== undefined && digest(parsed.data) !== row.digest) refuseWork("corrupt");
  return parsed.data;
}

/** Indexed rows and semantic receipts share the existing SQLite transaction and journal. */
export function createSqliteWorkQueueStore(
  store: SqliteStorePort,
  options: {
    readonly locator: string;
    readonly durability: "ephemeral" | "durable";
  },
): WorkQueueStore {
  function transactionPort(sql: SqliteStatements): WorkQueueTransaction {
    const pending = new Set<string>();
    const verified = new Map<string, WorkReceipt>();
    const edgesDigest = (queue: WorkQueueId, revision: number) => {
      const hash = createHash("sha256");
      let afterItem = "",
        afterDependency = "",
        count = 0;
      for (;;) {
        const rows = sql.all(
          "SELECT item_id,dependency_id,present FROM work_dependency_versions WHERE queue_id=$queue AND revision=$revision AND (item_id,dependency_id)>($afterItem,$afterDependency) ORDER BY item_id,dependency_id LIMIT 100",
          { queue, revision, afterItem, afterDependency },
        );
        for (const row of rows) {
          if (
            ++count > WORK_QUEUE_LIMITS.traversalSteps ||
            typeof row.item_id !== "string" ||
            typeof row.dependency_id !== "string" ||
            (row.present !== 0 && row.present !== 1)
          )
            refuseWork("corrupt");
          hash.update(JSON.stringify([row.item_id, row.dependency_id, row.present]));
          afterItem = row.item_id;
          afterDependency = row.dependency_id;
        }
        if (rows.length < 100) return hash.digest("hex");
      }
    };
    const placementsDigest = (queue: WorkQueueId, revision: number) => {
      const hash = createHash("sha256");
      let after = "",
        count = 0;
      for (;;) {
        const rows = sql.all(
          "SELECT node_id,parent_id,order_key FROM work_placement_versions WHERE queue_id=$queue AND revision=$revision AND node_id>$after ORDER BY node_id LIMIT 100",
          { queue, revision, after },
        );
        for (const row of rows) {
          if (
            ++count > WORK_QUEUE_LIMITS.traversalSteps ||
            typeof row.node_id !== "string" ||
            (row.parent_id !== null && typeof row.parent_id !== "string") ||
            typeof row.order_key !== "string"
          )
            refuseWork("corrupt");
          hash.update(JSON.stringify([row.node_id, row.parent_id, row.order_key]));
          after = row.node_id;
        }
        if (rows.length < 100) return hash.digest("hex");
      }
    };
    const itemKey = (queue: WorkQueueId, item: string) => JSON.stringify([queue, item]);
    const readReceipt = (row: SqliteRow | undefined): WorkReceipt | null => {
      const receipt = decode(row, workReceiptSchema, 65_536);
      if (receipt === null) return null;
      if (
        row?.queue_id !== receipt.queueId ||
        row.revision !== receipt.revision ||
        row.mutation_id !== receipt.mutationId
      )
        refuseWork("corrupt");
      const key = JSON.stringify([receipt.queueId, receipt.revision]);
      const cached = verified.get(key);
      if (cached !== undefined) {
        if (digest(cached) !== digest(receipt)) refuseWork("corrupt");
        return receipt;
      }
      const event = sql.all(
        "SELECT kind,sequence,payload FROM events WHERE stream_id=$stream AND sequence=$revision",
        { stream: queueStream(receipt.queueId), revision: receipt.revision },
      )[0];
      if (
        event?.kind !== "work.queue.changed" ||
        event.sequence !== receipt.revision ||
        typeof event.payload !== "string" ||
        Buffer.byteLength(event.payload) > 65_536
      )
        refuseWork("corrupt");
      let payload: unknown;
      try {
        payload = JSON.parse(event.payload);
      } catch {
        refuseWork("corrupt");
      }
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("payload" in payload) ||
        digest(payload.payload) !== digest(receipt)
      )
        refuseWork("corrupt");
      if (edgesDigest(receipt.queueId, receipt.revision) !== receipt.edgesDigest)
        refuseWork("corrupt");
      if (
        receipt.version === 2 &&
        placementsDigest(receipt.queueId, receipt.revision) !== receipt.placementsDigest
      )
        refuseWork("corrupt");
      if (verified.size >= 100) verified.clear();
      verified.set(key, receipt);
      return receipt;
    };
    const readItem = (row: SqliteRow | undefined): WorkItem | null => {
      const item = decode(row, workItemSchema, WORK_QUEUE_LIMITS.recordBytes);
      if (item === null) return null;
      if (
        row?.queue_id !== item.queueId ||
        row.item_id !== item.id ||
        row.revision !== item.revision
      )
        refuseWork("corrupt");
      if (!pending.has(itemKey(item.queueId, item.id))) {
        const receipt = readReceipt(
          sql.all("SELECT * FROM work_mutations WHERE queue_id=$queue AND revision=$revision", {
            queue: item.queueId,
            revision: item.revision,
          })[0],
        );
        if (!receipt?.items.some((entry) => entry.id === item.id && entry.digest === digest(item)))
          refuseWork("corrupt");
      }
      return item;
    };
    const readGroup = (row: SqliteRow | undefined): WorkGroup | null => {
      const group = decode(row, workGroupSchema, WORK_QUEUE_LIMITS.recordBytes);
      if (group === null) return null;
      if (
        row?.queue_id !== group.queueId ||
        row.group_id !== group.id ||
        row.revision !== group.revision
      )
        refuseWork("corrupt");
      if (!pending.has(itemKey(group.queueId, `group:${group.id}`))) {
        const receipt = readReceipt(
          sql.all("SELECT * FROM work_mutations WHERE queue_id=$queue AND revision=$revision", {
            queue: group.queueId,
            revision: group.revision,
          })[0],
        );
        if (
          receipt?.version !== 2 ||
          !receipt.groups.some((entry) => entry.id === group.id && entry.digest === digest(group))
        )
          refuseWork("corrupt");
      }
      return group;
    };
    const placementRow = (row: SqliteRow | undefined): WorkPlacement | null => {
      if (row === undefined) return null;
      const parent = row.parent_id === null ? null : workItemIdSchema.safeParse(row.parent_id);
      if (
        (parent !== null && !parent.success) ||
        typeof row.order_key !== "string" ||
        row.order_key.length === 0 ||
        row.order_key.length > 128
      )
        refuseWork("corrupt");
      return { parent: parent === null ? null : parent.data, order: row.order_key };
    };
    const childRow = (row: SqliteRow): WorkChild => {
      const id = workItemIdSchema.safeParse(row.id);
      if (!id.success || typeof row.ord !== "string") refuseWork("corrupt");
      return { id: id.data, order: row.ord };
    };
    return {
      edgesDigest,
      placementsDigest,
      group: (queue, id) =>
        readGroup(
          sql.all("SELECT * FROM work_groups WHERE queue_id=$queue AND group_id=$id", {
            queue,
            id,
          })[0],
        ),
      putGroup(group) {
        if (!workGroupSchema.safeParse(group).success) refuseWork("malformed");
        const binding = {
          queue: group.queueId,
          id: group.id,
          revision: group.revision,
          record: JSON.stringify(group),
          digest: digest(group),
        };
        sql.run(
          "INSERT INTO work_groups(queue_id,group_id,revision,record,digest) VALUES($queue,$id,$revision,$record,$digest) ON CONFLICT(queue_id,group_id) DO UPDATE SET revision=excluded.revision,record=excluded.record,digest=excluded.digest",
          binding,
        );
        sql.run(
          "INSERT INTO work_group_versions(queue_id,group_id,revision,record,digest) VALUES($queue,$id,$revision,$record,$digest) ON CONFLICT(queue_id,group_id,revision) DO UPDATE SET record=excluded.record,digest=excluded.digest",
          binding,
        );
        pending.add(itemKey(group.queueId, `group:${group.id}`));
      },
      placement(queue, node) {
        const current = placementRow(
          sql.all(
            "SELECT parent_id,order_key FROM work_placements WHERE queue_id=$queue AND node_id=$node",
            {
              queue,
              node,
            },
          )[0],
        );
        const latest = placementRow(
          sql.all(
            "SELECT parent_id,order_key FROM work_placement_versions WHERE queue_id=$queue AND node_id=$node ORDER BY revision DESC LIMIT 1",
            { queue, node },
          )[0],
        );
        // The current row must be the latest recorded version; anything else was edited outside a mutation.
        if (JSON.stringify(current) !== JSON.stringify(latest)) refuseWork("corrupt");
        return current;
      },
      setPlacement(queue, node, placement) {
        const row = sql.all("SELECT revision FROM work_queues WHERE queue_id=$queue", { queue })[0];
        if (typeof row?.revision !== "number") refuseWork("corrupt");
        const binding = { queue, node, parent: placement.parent, order: placement.order };
        sql.run(
          "INSERT INTO work_placements(queue_id,node_id,parent_id,order_key) VALUES($queue,$node,$parent,$order) ON CONFLICT(queue_id,node_id) DO UPDATE SET parent_id=excluded.parent_id,order_key=excluded.order_key",
          binding,
        );
        sql.run(
          "INSERT INTO work_placement_versions(queue_id,node_id,revision,parent_id,order_key) VALUES($queue,$node,$revision,$parent,$order) ON CONFLICT(queue_id,node_id,revision) DO UPDATE SET parent_id=excluded.parent_id,order_key=excluded.order_key",
          { ...binding, revision: row.revision + 1 },
        );
      },
      children(queue, parent, after, limit, direction = "forward") {
        const forward = direction === "forward";
        const source =
          parent === null
            ? "SELECT node_id AS id, order_key AS ord FROM work_placements WHERE queue_id=$queue AND parent_id IS NULL UNION ALL SELECT i.item_id AS id, i.item_id AS ord FROM work_items i WHERE i.queue_id=$queue AND NOT EXISTS (SELECT 1 FROM work_placements p WHERE p.queue_id=i.queue_id AND p.node_id=i.item_id)"
            : "SELECT node_id AS id, order_key AS ord FROM work_placements WHERE queue_id=$queue AND parent_id=$parent";
        const bound =
          after === null ? "" : forward ? "WHERE (ord,id)>($ord,$id)" : "WHERE (ord,id)<($ord,$id)";
        return sql
          .all(
            `SELECT id,ord FROM (${source}) ${bound} ORDER BY ord ${forward ? "ASC" : "DESC"}, id ${forward ? "ASC" : "DESC"} LIMIT $limit`,
            {
              queue,
              ...(parent === null ? {} : { parent }),
              ...(after === null ? {} : { ord: after.order, id: after.id }),
              limit: Math.min(limit, WORK_QUEUE_LIMITS.page),
            },
          )
          .map(childRow);
      },
      queueAt(id, revision) {
        const current = this.queue(id);
        if (current === null || revision < 1 || revision > current.revision) return null;
        const receipt = readReceipt(
          sql.all("SELECT * FROM work_mutations WHERE queue_id=$id AND revision=$revision", {
            id,
            revision,
          })[0],
        );
        if (receipt === null) refuseWork("recovery-required");
        const queue = { ...current, revision, updatedAt: receipt.at };
        if (digest(queue) !== receipt.queueDigest) refuseWork("corrupt");
        return queue;
      },
      queue(id) {
        const row = sql.all("SELECT * FROM work_queues WHERE queue_id=$id", { id })[0];
        const queue = decode(row, workQueueSchema, WORK_QUEUE_LIMITS.recordBytes);
        if (queue !== null) {
          if (queue.id !== id || row?.revision !== queue.revision) refuseWork("corrupt");
          const receipt = readReceipt(
            sql.all("SELECT * FROM work_mutations WHERE queue_id=$id AND revision=$revision", {
              id,
              revision: queue.revision,
            })[0],
          );
          if (
            receipt === null ||
            receipt.scopeGeneration !== queue.scope.generation ||
            receipt.queueDigest !== digest(queue)
          )
            refuseWork("recovery-required");
        }
        return queue;
      },
      putQueue(queue) {
        if (!workQueueSchema.safeParse(queue).success) refuseWork("malformed");
        sql.run(
          "INSERT INTO work_queues(queue_id,revision,record,digest) VALUES($id,$revision,$record,$digest) ON CONFLICT(queue_id) DO UPDATE SET revision=excluded.revision,record=excluded.record,digest=excluded.digest",
          {
            id: queue.id,
            revision: queue.revision,
            record: JSON.stringify(queue),
            digest: digest(queue),
          },
        );
      },
      item: (queue, id) =>
        readItem(
          sql.all("SELECT * FROM work_items WHERE queue_id=$queue AND item_id=$id", {
            queue,
            id,
          })[0],
        ),
      putItem(item) {
        const binding = {
          queue: item.queueId,
          id: item.id,
          revision: item.revision,
          record: JSON.stringify(item),
          digest: digest(item),
        };
        sql.run(
          "INSERT INTO work_items(queue_id,item_id,revision,record,digest) VALUES($queue,$id,$revision,$record,$digest) ON CONFLICT(queue_id,item_id) DO UPDATE SET revision=excluded.revision,record=excluded.record,digest=excluded.digest",
          binding,
        );
        sql.run(
          "INSERT INTO work_item_versions(queue_id,item_id,revision,record,digest) VALUES($queue,$id,$revision,$record,$digest) ON CONFLICT(queue_id,item_id,revision) DO UPDATE SET record=excluded.record,digest=excluded.digest",
          binding,
        );
        pending.add(itemKey(item.queueId, item.id));
      },
      items(queue, after, limit) {
        return sql
          .all(
            "SELECT * FROM work_items WHERE queue_id=$queue AND item_id>$after ORDER BY item_id LIMIT $limit",
            { queue, after, limit: Math.min(limit, WORK_QUEUE_LIMITS.page) },
          )
          .map((row) => {
            const item = readItem(row);
            if (item === null) refuseWork("corrupt");
            return item;
          });
      },
      itemsAt(queue, revision, after, limit) {
        return sql
          .all(
            "SELECT v.* FROM work_item_versions v WHERE v.queue_id=$queue AND v.item_id>$after AND v.revision=(SELECT MAX(h.revision) FROM work_item_versions h WHERE h.queue_id=v.queue_id AND h.item_id=v.item_id AND h.revision<=$revision) ORDER BY v.item_id LIMIT $limit",
            { queue, revision, after, limit: Math.min(limit, 100) },
          )
          .map((row) => {
            const item = readItem(row);
            if (item === null) refuseWork("corrupt");
            return item;
          });
      },
      edges(queue, item, direction, after, revision) {
        const owner = direction === "dependencies" ? "item_id" : "dependency_id";
        const target = direction === "dependencies" ? "dependency_id" : "item_id";
        const rows =
          revision === undefined
            ? sql.all(
                `SELECT ${target} AS id FROM work_dependencies WHERE queue_id=$queue AND ${owner}=$item AND ${target}>$after ORDER BY ${target} LIMIT 100`,
                { queue, item, after },
              )
            : sql.all(
                `SELECT v.${target} AS id FROM work_dependency_versions v WHERE v.queue_id=$queue AND v.${owner}=$item AND v.${target}>$after AND v.revision=(SELECT MAX(h.revision) FROM work_dependency_versions h WHERE h.queue_id=v.queue_id AND h.item_id=v.item_id AND h.dependency_id=v.dependency_id AND h.revision<=$revision) AND v.present=1 ORDER BY v.${target} LIMIT 100`,
                { queue, item, after, revision },
              );
        if (revision === undefined) {
          const expected = sql.all(
            `SELECT v.${target} AS id FROM work_dependency_versions v WHERE v.queue_id=$queue AND v.${owner}=$item AND v.${target}>$after AND v.revision=(SELECT MAX(h.revision) FROM work_dependency_versions h WHERE h.queue_id=v.queue_id AND h.item_id=v.item_id AND h.dependency_id=v.dependency_id) AND v.present=1 ORDER BY v.${target} LIMIT 100`,
            { queue, item, after },
          );
          if (JSON.stringify(rows) !== JSON.stringify(expected)) refuseWork("corrupt");
        }
        return rows.map((row) => {
          const id = workItemIdSchema.safeParse(row.id);
          if (!id.success) refuseWork("corrupt");
          return id.data;
        });
      },
      setEdge(queue, edge, present) {
        const row = sql.all("SELECT revision FROM work_queues WHERE queue_id=$queue", { queue })[0];
        if (typeof row?.revision !== "number") refuseWork("corrupt");
        sql.run(
          "INSERT INTO work_dependency_versions(queue_id,item_id,dependency_id,revision,present) VALUES($queue,$item,$dependency,$revision,$present) ON CONFLICT(queue_id,item_id,dependency_id,revision) DO UPDATE SET present=excluded.present",
          { queue, ...edge, revision: row.revision + 1, present: Number(present) },
        );
        if (present)
          sql.run(
            "INSERT OR IGNORE INTO work_dependencies(queue_id,item_id,dependency_id) VALUES($queue,$item,$dependency)",
            { queue, ...edge },
          );
        else
          sql.run(
            "DELETE FROM work_dependencies WHERE queue_id=$queue AND item_id=$item AND dependency_id=$dependency",
            { queue, ...edge },
          );
      },
      receipt(queue, mutation) {
        return readReceipt(
          sql.all("SELECT * FROM work_mutations WHERE queue_id=$queue AND mutation_id=$mutation", {
            queue,
            mutation,
          })[0],
        );
      },
      appendReceipt(queue, receipt) {
        const stream = queueStream(queue.id);
        const identity = `${stream}:${receipt.revision}`;
        const event: WorkQueueChangedEvent = {
          eventId: eventId.from(identity),
          streamId: streamId.from(stream),
          sequence: sequence.from(receipt.revision),
          idempotencyKey: idempotencyKey.from(identity),
          schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
          minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
          occurredAt: timestampFromEpochMilliseconds(receipt.at),
          kind: "work.queue.changed",
          correlation: {
            sessionId: sessionId.from(queue.scope.sessionId ?? `queue:${queue.id}`),
            workspaceId: workspaceId.from(queue.scope.workspaceId),
            traceId: traceId.from(stream),
            configurationGeneration: configurationGeneration.from(
              queue.scope.configurationGeneration,
            ),
          },
          payload: receipt,
        };
        const appended = appendRuntimeEventInTransaction(sql, event);
        if (!appended.ok || appended.value.kind !== "appended") refuseWork("recovery-required");
        sql.run(
          "INSERT INTO work_mutations(queue_id,mutation_id,revision,record) VALUES($queue,$mutation,$revision,$record)",
          {
            queue: queue.id,
            mutation: receipt.mutationId,
            revision: receipt.revision,
            record: JSON.stringify(receipt),
          },
        );
      },
      history(queue, afterRevision, limit) {
        const receipts: WorkReceipt[] = [];
        let bytes = 0;
        for (const row of sql.all(
          "SELECT * FROM work_mutations WHERE queue_id=$queue AND revision>$afterRevision ORDER BY revision LIMIT $limit",
          { queue, afterRevision, limit: Math.min(limit, 100) },
        )) {
          const receipt = readReceipt(row);
          if (receipt === null) refuseWork("corrupt");
          const size = Buffer.byteLength(JSON.stringify(receipt));
          if (bytes + size > WORK_QUEUE_LIMITS.responseBytes - 32_768) break;
          receipts.push(receipt);
          bytes += size;
        }
        return receipts;
      },
      binding(session, workspace) {
        const row = sql.all(
          "SELECT queue_id FROM work_queue_bindings WHERE session_id=$session AND workspace_id=$workspace",
          { session, workspace },
        )[0];
        if (row === undefined) return null;
        const id = workQueueIdSchema.safeParse(row.queue_id);
        if (!id.success) refuseWork("corrupt");
        return id.data;
      },
      bind(session, workspace, queue) {
        sql.run(
          "INSERT INTO work_queue_bindings(session_id,workspace_id,queue_id) VALUES($session,$workspace,$queue)",
          { session, workspace, queue },
        );
      },
    };
  }
  return {
    ...options,
    transaction<T>(work: (tx: WorkQueueTransaction) => T, signal?: AbortSignal): WorkResult<T> {
      let refusal: WorkQueueRefusal | null = null;
      const written = store.write((sql) => {
        try {
          return work(transactionPort(sql));
        } catch (error) {
          if (error instanceof WorkQueueRefusal) refusal = error;
          throw error;
        }
      }, signal);
      if (refusal !== null) return err((refusal as WorkQueueRefusal).failure);
      if (written.ok) return ok(written.value.value);
      return err({
        code:
          written.error.effect === "uncertain"
            ? "recovery-required"
            : written.error.code === "cancelled"
              ? "cancelled-operation"
              : written.error.code === "disk-full"
                ? "resource-exhausted"
                : "unavailable",
        dimension: "storage",
      });
    },
  };
}
