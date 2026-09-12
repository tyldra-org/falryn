import type { Migration } from "../../domain/storage/index.ts";
export const REFLECTION_REQUESTS_TABLE = "reflection_requests";
export const MIGRATION_0025: Migration = {
  version: 25,
  name: "create-reflection-requests",
  destructive: false,
  statements: [
    `CREATE TABLE reflection_requests (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      record TEXT NOT NULL CHECK (length(CAST(record AS BLOB)) <= 524288),
      digest TEXT NOT NULL
    ) STRICT`,
    "CREATE INDEX reflection_requests_by_session ON reflection_requests(session_id,request_id)",
  ],
};
