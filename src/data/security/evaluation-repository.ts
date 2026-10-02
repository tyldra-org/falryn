import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  EVALUATION_LIMITS,
  type EvaluationRecord,
  type EvaluationStore,
  evaluationRecordSchema,
} from "../../domain/security/package-evaluation.ts";
import type { Migration, SqliteStatements, SqliteStorePort } from "../../domain/storage/index.ts";

export const PACKAGE_EVALUATIONS_TABLE = "package_evaluations";
/** Records are bounded by the report limit plus the fixed record envelope. */
const RECORD_BYTES = EVALUATION_LIMITS.reportBytes + 4_096;
/**
 * Retained evaluation evidence (#168). A record is a report someone produced about one exact
 * package identity; it never stores trust decisions, grants, package bytes, keys or signatures.
 */
export const MIGRATION_0036: Migration = {
  version: 36,
  name: "create-package-evaluations",
  destructive: false,
  statements: [
    `CREATE TABLE ${PACKAGE_EVALUATIONS_TABLE} (
    sequence INTEGER PRIMARY KEY,
    record_key TEXT NOT NULL UNIQUE,
    package_id TEXT NOT NULL,
    identity_digest TEXT NOT NULL,
    recorded_at INTEGER NOT NULL CHECK (recorded_at >= 0),
    record_json TEXT NOT NULL CHECK (length(CAST(record_json AS BLOB)) BETWEEN 1 AND ${RECORD_BYTES})
  ) STRICT`,
    `CREATE INDEX package_evaluations_by_package ON ${PACKAGE_EVALUATIONS_TABLE} (package_id, sequence)`,
    `CREATE INDEX package_evaluations_by_identity ON ${PACKAGE_EVALUATIONS_TABLE} (identity_digest, sequence)`,
  ],
};

/** One record per identity, report facts and carrying statement; an unchanged repeat is the same key. */
function recordKey(record: EvaluationRecord): string {
  return canonicalDigest({
    identity: record.identityDigest,
    report: record.reportDigest,
    statement: record.curation?.statementDigest ?? null,
  });
}

function decode(row: Record<string, unknown>): EvaluationRecord | null {
  if (
    typeof row.record_json !== "string" ||
    Buffer.byteLength(row.record_json) > RECORD_BYTES ||
    typeof row.record_key !== "string"
  )
    return null;
  try {
    const parsed = evaluationRecordSchema.safeParse(JSON.parse(row.record_json));
    return parsed.success &&
      recordKey(parsed.data) === row.record_key &&
      parsed.data.packageId === row.package_id &&
      parsed.data.identityDigest === row.identity_digest
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

/**
 * Append inside a caller's transaction. Used by the evaluation store and by the provenance store,
 * which retains a curator report in the same transaction as the evidence refresh that carried it.
 * Throws on a record that cannot be stored, which rolls the caller's transaction back.
 */
export function appendEvaluation(sql: SqliteStatements, record: EvaluationRecord): boolean {
  const parsed = evaluationRecordSchema.safeParse(record);
  const json = JSON.stringify(parsed.success ? parsed.data : null);
  if (!parsed.success || Buffer.byteLength(json) > RECORD_BYTES)
    throw new Error("evaluation-record-malformed");
  const key = recordKey(parsed.data);
  if (
    sql.all(`SELECT 1 FROM ${PACKAGE_EVALUATIONS_TABLE} WHERE record_key=$key`, { key }).length > 0
  )
    return false;
  sql.run(
    `INSERT INTO ${PACKAGE_EVALUATIONS_TABLE}(record_key,package_id,identity_digest,recorded_at,record_json) VALUES($key,$package,$identity,$time,$json)`,
    {
      key,
      package: parsed.data.packageId,
      identity: parsed.data.identityDigest,
      time: parsed.data.recordedAt,
      json,
    },
  );
  // Oldest first beyond each bound; a newer identity never displaces its own newest records.
  sql.run(
    `DELETE FROM ${PACKAGE_EVALUATIONS_TABLE} WHERE identity_digest=$identity AND sequence NOT IN (SELECT sequence FROM ${PACKAGE_EVALUATIONS_TABLE} WHERE identity_digest=$identity ORDER BY sequence DESC LIMIT $limit)`,
    { identity: parsed.data.identityDigest, limit: EVALUATION_LIMITS.historyPerIdentity },
  );
  sql.run(
    `DELETE FROM ${PACKAGE_EVALUATIONS_TABLE} WHERE sequence NOT IN (SELECT sequence FROM ${PACKAGE_EVALUATIONS_TABLE} ORDER BY sequence DESC LIMIT $limit)`,
    { limit: EVALUATION_LIMITS.historyTotal },
  );
  return true;
}

export function createEvaluationRepository(store: SqliteStorePort): EvaluationStore {
  return {
    append(record, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      if (!evaluationRecordSchema.safeParse(record).success) return err({ code: "malformed" });
      const result = store.write((sql) => appendEvaluation(sql, record), signal);
      if (!result.ok)
        return err({ code: result.error.effect === "uncertain" ? "uncertain" : "unavailable" });
      return ok({ added: result.value.value });
    },
    history(packageId, limit) {
      const rows = store.read(
        `SELECT * FROM ${PACKAGE_EVALUATIONS_TABLE} WHERE package_id=$package ORDER BY sequence DESC LIMIT $limit`,
        {
          package: packageId,
          limit: Math.max(0, Math.min(limit, EVALUATION_LIMITS.historyPerIdentity)),
        },
      );
      if (!rows.ok) return err({ code: "unavailable" });
      const records: EvaluationRecord[] = [];
      for (const row of rows.value) {
        const record = decode(row);
        // One unreadable record fails the whole answer rather than shortening history silently.
        if (record === null) return err({ code: "malformed" });
        records.push(record);
      }
      return ok(records);
    },
  };
}
