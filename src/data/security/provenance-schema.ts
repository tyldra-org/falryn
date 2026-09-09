import type { Migration } from "../../domain/storage/index.ts";
export const PROVENANCE_TABLES = [
  "package_provenance",
  "full_user_grants",
  "package_trust_receipts",
] as const;
export const MIGRATION_0017: Migration = {
  version: 17,
  name: "package-provenance-and-exact-grants",
  destructive: false,
  statements: [
    "CREATE TABLE package_provenance (evidence_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) BETWEEN 1 AND 16384)) STRICT",
    "CREATE TABLE full_user_grants (grant_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, actor TEXT NOT NULL, evidence_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) BETWEEN 1 AND 524288), UNIQUE(identity_key, actor)) STRICT",
    "CREATE TABLE package_trust_receipts (sequence INTEGER PRIMARY KEY, subject_id TEXT NOT NULL, revision INTEGER NOT NULL, record_digest TEXT NOT NULL, action TEXT NOT NULL, observed_at INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) BETWEEN 1 AND 524288), UNIQUE(subject_id, revision)) STRICT",
  ],
};
