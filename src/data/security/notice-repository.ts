import { err, ok } from "../../domain/foundation/result.ts";
import {
  NOTICE_LIMITS,
  type NoticeAcknowledgement,
  type NoticeAcknowledgementStore,
  noticeAcknowledgementKey,
  noticeAcknowledgementSchema,
} from "../../domain/security/ecosystem-notice.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";

export const NOTICE_ACKNOWLEDGEMENTS_TABLE = "ecosystem_notice_acknowledgements";
/**
 * Acknowledgements are the only stored notice state. Notices themselves are derived from trust,
 * compatibility and health facts on every read, so this table never owns a grant, quarantine or
 * revocation and holds no package content, key or signature.
 */
export const MIGRATION_0035: Migration = {
  version: 35,
  name: "create-ecosystem-notice-acknowledgements",
  destructive: false,
  statements: [
    `CREATE TABLE ${NOTICE_ACKNOWLEDGEMENTS_TABLE} (
    acknowledgement_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > 0),
    record_json TEXT NOT NULL CHECK (length(CAST(record_json AS BLOB)) BETWEEN 1 AND ${NOTICE_LIMITS.acknowledgementBytes})
  ) STRICT`,
  ],
};

function decode(row: Record<string, unknown>, key: string): NoticeAcknowledgement | null {
  if (
    typeof row.record_json !== "string" ||
    new TextEncoder().encode(row.record_json).length > NOTICE_LIMITS.acknowledgementBytes
  )
    return null;
  try {
    const parsed = noticeAcknowledgementSchema.safeParse(JSON.parse(row.record_json));
    if (
      !parsed.success ||
      parsed.data.revision !== row.revision ||
      noticeAcknowledgementKey(parsed.data.noticeId, parsed.data.scope) !== key
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function createNoticeAcknowledgementRepository(
  store: SqliteStorePort,
): NoticeAcknowledgementStore {
  return {
    get(key) {
      const rows = store.read(
        `SELECT revision, record_json FROM ${NOTICE_ACKNOWLEDGEMENTS_TABLE} WHERE acknowledgement_key = $key`,
        { key },
      );
      if (!rows.ok) return err({ code: "unavailable" });
      const row = rows.value[0];
      if (row === undefined) return ok(null);
      const record = decode(row, key);
      return record === null ? err({ code: "malformed" }) : ok(record);
    },
    replace(key, expectedRevision, record, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      const json = JSON.stringify(record);
      if (
        !noticeAcknowledgementSchema.safeParse(record).success ||
        new TextEncoder().encode(json).length > NOTICE_LIMITS.acknowledgementBytes ||
        record.revision !== expectedRevision + 1 ||
        noticeAcknowledgementKey(record.noticeId, record.scope) !== key
      )
        return err({ code: "malformed" });
      const written = store.write((statements) => {
        const existing = statements.all(
          `SELECT revision, record_json FROM ${NOTICE_ACKNOWLEDGEMENTS_TABLE} WHERE acknowledgement_key = $key`,
          { key },
        )[0];
        // A corrupt row protects no valid state; a caller that expects none may replace it.
        const corrupt = existing !== undefined && decode(existing, key) === null;
        if (corrupt && expectedRevision !== 0) return "malformed" as const;
        if (!corrupt && (existing?.revision ?? 0) !== expectedRevision) return "conflict" as const;
        // Expired acknowledgements hide nothing, so the table holds only live ones.
        statements.run(
          `DELETE FROM ${NOTICE_ACKNOWLEDGEMENTS_TABLE} WHERE expires_at <= $now AND acknowledgement_key <> $key`,
          { now: record.acknowledgedAt, key },
        );
        if (
          existing === undefined &&
          Number(
            statements.all(`SELECT COUNT(*) AS total FROM ${NOTICE_ACKNOWLEDGEMENTS_TABLE}`)[0]
              ?.total ?? 0,
          ) >= NOTICE_LIMITS.records
        )
          return "limit" as const;
        statements.run(
          `INSERT INTO ${NOTICE_ACKNOWLEDGEMENTS_TABLE} (acknowledgement_key, revision, expires_at, record_json) VALUES ($key, $revision, $expires, $json) ON CONFLICT(acknowledgement_key) DO UPDATE SET revision = excluded.revision, expires_at = excluded.expires_at, record_json = excluded.record_json`,
          { key, revision: record.revision, expires: record.expiresAt, json },
        );
        return null;
      }, signal);
      if (!written.ok)
        return err({ code: written.error.effect === "uncertain" ? "uncertain" : "unavailable" });
      return written.value.value === null ? ok(null) : err({ code: written.value.value });
    },
  };
}
