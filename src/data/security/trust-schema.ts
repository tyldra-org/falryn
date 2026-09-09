import type { Migration } from "../../domain/storage/index.ts";

export const TRUST_DECISIONS_TABLE = "trust_decisions";
export const MIGRATION_0012: Migration = {
  version: 12,
  name: "create-scoped-trust-decisions",
  destructive: false,
  statements: [
    `CREATE TABLE ${TRUST_DECISIONS_TABLE} (
    decision_key TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    decision_json TEXT NOT NULL CHECK (length(CAST(decision_json AS BLOB)) BETWEEN 1 AND 131072)
  ) STRICT`,
  ],
};
