import type { Migration } from "../../domain/storage/index.ts";

export const MIGRATION_0027: Migration = {
  version: 27,
  name: "retain-session-conversation-ancestry",
  statements: [
    "ALTER TABLE sessions ADD COLUMN history_parent TEXT CHECK (history_parent IS NULL OR length(CAST(history_parent AS BLOB)) <= 2048)",
  ],
  destructive: false,
};
