import { err, ok } from "../../domain/foundation/result.ts";
import {
  REFLECTION_LIMITS,
  type ReflectionBinding,
  type ReflectionErrorCode,
  type ReflectionRecord,
  ReflectionRefusal,
  type ReflectionRepository,
  type ReflectionResult,
  type ReflectionTransaction,
  refuseReflection,
} from "../../domain/memory/reflection.ts";
import {
  reflectionBytes,
  reflectionDigest,
  validateReflectionRecord,
} from "../../domain/memory/reflection-state.ts";
import { decodeRuntimeEvent } from "../../domain/sessions/codec.ts";
import type { SqliteRow, SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";

function decode(row: SqliteRow | undefined): ReflectionRecord | null {
  if (!row) return null;
  if (
    typeof row.record !== "string" ||
    Buffer.byteLength(row.record) > REFLECTION_LIMITS.recordBytes
  )
    refuseReflection("corrupt");
  let value: unknown;
  try {
    value = JSON.parse(row.record);
  } catch {
    refuseReflection("corrupt");
  }
  const record = validateReflectionRecord(value);
  if (
    row.request_id !== record.id ||
    row.session_id !== record.binding.sessionId ||
    row.revision !== record.revision ||
    row.digest !== reflectionDigest(record)
  )
    refuseReflection("corrupt");
  return record;
}
function sourceSession(sql: SqliteStatements, binding: ReflectionBinding) {
  const session = sql.all("SELECT workspace_id,stream_id FROM sessions WHERE session_id=$id", {
    id: binding.sessionId,
  })[0];
  if (
    !session ||
    session.workspace_id !== binding.workspaceId ||
    session.stream_id !== binding.streamId
  )
    refuseReflection("source-unavailable");
}
function transactionPort(sql: SqliteStatements): ReflectionTransaction {
  return {
    get(id) {
      return decode(sql.all("SELECT * FROM reflection_requests WHERE request_id=$id", { id })[0]);
    },
    list(sessionId, after, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > REFLECTION_LIMITS.page)
        refuseReflection("malformed");
      return sql
        .all(
          "SELECT * FROM reflection_requests WHERE session_id=$session AND request_id>$after ORDER BY request_id LIMIT $limit",
          { session: sessionId, after: after ?? "", limit },
        )
        .map((row) => {
          const record = decode(row);
          if (!record) refuseReflection("corrupt");
          return record;
        });
    },
    save(record, expectedRevision) {
      validateReflectionRecord(record);
      const previous = this.get(record.id);
      if (expectedRevision === null) {
        if (previous !== null || record.revision !== 1) refuseReflection("conflict");
        const count = sql.all(
          "SELECT count(*) AS count FROM reflection_requests WHERE session_id=$id",
          { id: record.binding.sessionId },
        )[0]?.count;
        if (typeof count !== "number" || count >= REFLECTION_LIMITS.requestsPerSession)
          refuseReflection("resource-exhausted");
        sql.run(
          "INSERT INTO reflection_requests(request_id,session_id,revision,record,digest) VALUES($id,$session,$revision,$record,$digest)",
          {
            id: record.id,
            session: record.binding.sessionId,
            revision: record.revision,
            record: JSON.stringify(record),
            digest: reflectionDigest(record),
          },
        );
      } else {
        if (
          !previous ||
          previous.revision !== expectedRevision ||
          record.revision !== expectedRevision + 1
        )
          refuseReflection("conflict");
        const immutable = (r: ReflectionRecord) => ({
          id: r.id,
          binding: r.binding,
          transform: r.transform,
          range: r.range,
          sources: r.sources,
          sourceDigest: r.sourceDigest,
          createdAt: r.createdAt,
          reason: r.reason,
        });
        if (
          reflectionDigest(immutable(previous)) !== reflectionDigest(immutable(record)) ||
          record.epoch < previous.epoch ||
          !["candidates", "publications", "invalidations"].every((key) => {
            const field = key as "candidates" | "publications" | "invalidations";
            return (
              record[field].length >= previous[field].length &&
              reflectionDigest(record[field].slice(0, previous[field].length)) ===
                reflectionDigest(previous[field])
            );
          })
        )
          refuseReflection("conflict");
        sql.run(
          "UPDATE reflection_requests SET revision=$revision,record=$record,digest=$digest WHERE request_id=$id AND revision=$expected",
          {
            revision: record.revision,
            record: JSON.stringify(record),
            digest: reflectionDigest(record),
            id: record.id,
            expected: expectedRevision,
          },
        );
      }
    },
    committedThrough(binding) {
      sourceSession(sql, binding);
      const last = sql.all("SELECT max(sequence) AS last FROM events WHERE stream_id=$stream", {
        stream: binding.streamId,
      })[0]?.last;
      if (typeof last !== "number" || !Number.isSafeInteger(last))
        refuseReflection("source-unavailable");
      return last;
    },
    source(binding, range) {
      sourceSession(sql, binding);
      if (range.last - range.first + 1 > REFLECTION_LIMITS.sourceEvents)
        refuseReflection("source-too-large");
      const bounds = { stream: binding.streamId, first: range.first, last: range.last };
      const size = sql.all(
        "SELECT count(*) AS count,sum(length(CAST(payload AS BLOB))) AS bytes FROM events WHERE stream_id=$stream AND sequence BETWEEN $first AND $last",
        bounds,
      )[0];
      if (size?.count !== range.last - range.first + 1) refuseReflection("source-unavailable");
      if (typeof size.bytes !== "number" || size.bytes > REFLECTION_LIMITS.sourceBytes)
        refuseReflection("source-too-large");
      return sql
        .all(
          "SELECT * FROM events WHERE stream_id=$stream AND sequence BETWEEN $first AND $last ORDER BY sequence",
          bounds,
        )
        .map((row, index) => {
          if (typeof row.payload !== "string" || row.sequence !== range.first + index)
            refuseReflection("corrupt");
          let payload: unknown;
          try {
            payload = JSON.parse(row.payload);
          } catch {
            refuseReflection("corrupt");
          }
          if (
            typeof payload !== "object" ||
            payload === null ||
            !("correlation" in payload) ||
            typeof payload.correlation !== "object" ||
            payload.correlation === null
          )
            refuseReflection("corrupt");
          const event = decodeRuntimeEvent(
            JSON.stringify({
              ...payload,
              eventId: row.event_id,
              streamId: row.stream_id,
              sequence: row.sequence,
              kind: row.kind,
              schemaVersion: row.schema_version,
              occurredAt: row.occurred_at,
              correlation: { ...payload.correlation, traceId: row.trace_id },
            }),
          );
          if (
            !event.ok ||
            event.value.correlation.sessionId !== binding.sessionId ||
            event.value.correlation.workspaceId !== binding.workspaceId
          )
            refuseReflection("corrupt");
          if (reflectionBytes(event.value) > REFLECTION_LIMITS.sourceBytes)
            refuseReflection("source-too-large");
          return {
            eventId: event.value.eventId,
            sequence: event.value.sequence,
            digest: reflectionDigest(event.value),
          };
        });
    },
    artifact(id, digest) {
      const row = sql.all(
        "SELECT digest,availability,sensitivity FROM artifacts WHERE artifact_id=$id",
        { id },
      )[0];
      return (
        row?.digest === digest &&
        row.availability === "available" &&
        row.sensitivity !== "restricted"
      );
    },
  };
}
/** Candidates, range dispositions and publication generations commit in one existing SQLite transaction. */
export function createReflectionRepository(store: SqliteStorePort): ReflectionRepository {
  return {
    transaction<T>(
      work: (tx: ReflectionTransaction) => T,
      signal?: AbortSignal,
    ): ReflectionResult<T> {
      const refusal: { code?: ReflectionErrorCode } = {};
      const result = store.write((sql) => {
        try {
          return work(transactionPort(sql));
        } catch (error) {
          if (error instanceof ReflectionRefusal) refusal.code = error.code;
          throw error;
        }
      }, signal);
      if (refusal.code) return err({ kind: "reflection", code: refusal.code });
      if (result.ok) return ok(result.value.value);
      return err({
        kind: "reflection",
        code:
          result.error.effect === "uncertain"
            ? "uncertain"
            : result.error.code === "cancelled"
              ? "cancelled"
              : result.error.code === "disk-full"
                ? "resource-exhausted"
                : "unavailable",
      });
    },
  };
}
