import { canonicalJson } from "../../domain/extensions/canonical.ts";
import {
  CURATED_RECORD_BYTES,
  CURATED_SOURCES,
  type CuratedCatalogStore,
  parseCuratedCatalogRecord,
  type StoredCuratedCatalog,
} from "../../domain/extensions/curated-catalog.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { Migration, SqliteRow, SqliteStorePort } from "../../domain/storage/index.ts";

export const CURATED_CATALOG_TABLE = "curated_catalogs";
/** One row per catalog source: its latest accepted normalized record (#165). */
export const MIGRATION_0034: Migration = {
  version: 34,
  name: "curated-catalogs",
  destructive: false,
  statements: [
    "CREATE TABLE curated_catalogs (source_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL CHECK(sequence > 0), digest TEXT NOT NULL, record_version INTEGER NOT NULL CHECK(record_version > 0), record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) BETWEEN 1 AND 4194304)) STRICT",
  ],
};

function decode(row: SqliteRow): StoredCuratedCatalog {
  const sourceId = String(row.source_id);
  const sequence = Number(row.sequence);
  const parsed =
    typeof row.record_json === "string"
      ? parseCuratedCatalogRecord(row.record_json)
      : ({ ok: false, code: "catalog-record-corrupt" } as const);
  if (!parsed.ok) return { sourceId, sequence, record: null, code: parsed.code };
  const { catalog } = parsed.record;
  // A row whose columns disagree with its body is corrupt, not a second record.
  if (
    catalog.source.id !== sourceId ||
    catalog.sequence !== sequence ||
    catalog.digest !== row.digest
  )
    return { sourceId, sequence, record: null, code: "catalog-record-corrupt" };
  return { sourceId, sequence, record: parsed.record, code: null };
}

/** Uses the existing SQLite writer; stores metadata only, never package bytes or authority. */
export function createCuratedCatalogRepository(store: SqliteStorePort): CuratedCatalogStore {
  return {
    get(sourceId) {
      const found = store.read(
        "SELECT source_id, sequence, digest, record_json FROM curated_catalogs WHERE source_id=$id",
        { id: sourceId },
      );
      if (!found.ok) return err({ code: "catalog-store-unavailable" });
      const row = found.value[0];
      return ok(row === undefined ? null : decode(row));
    },
    list() {
      const found = store.read(
        "SELECT source_id, sequence, digest, record_json FROM curated_catalogs ORDER BY source_id LIMIT $limit",
        { limit: CURATED_SOURCES },
      );
      return found.ok ? ok(found.value.map(decode)) : err({ code: "catalog-store-unavailable" });
    },
    replace(record, expectedSequence, signal) {
      const json = canonicalJson(record);
      if (Buffer.byteLength(json) > CURATED_RECORD_BYTES)
        return err({ code: "catalog-record-limit" });
      const { catalog } = record;
      const saved = store.write((tx) => {
        const current = tx.all("SELECT sequence FROM curated_catalogs WHERE source_id=$id", {
          id: catalog.source.id,
        })[0];
        const stored = current === undefined ? null : Number(current.sequence);
        if (stored !== expectedSequence) return "conflict" as const;
        if (stored === null) {
          const count = Number(
            tx.all("SELECT count(*) AS count FROM curated_catalogs")[0]?.count ?? 0,
          );
          if (count >= CURATED_SOURCES) return "limit" as const;
        }
        tx.run(
          "INSERT INTO curated_catalogs(source_id, sequence, digest, record_version, record_json) VALUES($id, $sequence, $digest, $version, $json) ON CONFLICT(source_id) DO UPDATE SET sequence=excluded.sequence, digest=excluded.digest, record_version=excluded.record_version, record_json=excluded.record_json",
          {
            id: catalog.source.id,
            sequence: catalog.sequence,
            digest: catalog.digest,
            version: record.recordVersion,
            json,
          },
        );
        return "saved" as const;
      }, signal);
      if (!saved.ok) return err({ code: "catalog-store-unavailable" });
      if (saved.value.value === "conflict") return err({ code: "catalog-store-conflict" });
      if (saved.value.value === "limit") return err({ code: "catalog-source-limit" });
      return ok(null);
    },
  };
}
