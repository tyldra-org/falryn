import type { Migration } from "../../domain/storage/index.ts";

export const WORK_QUEUE_TABLES = [
  "work_queues",
  "work_items",
  "work_item_versions",
  "work_dependencies",
  "work_dependency_versions",
  "work_mutations",
  "work_queue_bindings",
] as const;
export const MIGRATION_0021: Migration = {
  version: 21,
  name: "scoped-work-item-store",
  destructive: false,
  statements: [
    "CREATE TABLE work_queues (queue_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 32768), digest TEXT NOT NULL) STRICT",
    "CREATE TABLE work_items (queue_id TEXT NOT NULL REFERENCES work_queues(queue_id), item_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 32768), digest TEXT NOT NULL, PRIMARY KEY(queue_id,item_id)) STRICT",
    "CREATE TABLE work_item_versions (queue_id TEXT NOT NULL, item_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 32768), digest TEXT NOT NULL, PRIMARY KEY(queue_id,item_id,revision), FOREIGN KEY(queue_id,item_id) REFERENCES work_items(queue_id,item_id)) STRICT",
    "CREATE TABLE work_dependencies (queue_id TEXT NOT NULL, item_id TEXT NOT NULL, dependency_id TEXT NOT NULL, PRIMARY KEY(queue_id,item_id,dependency_id), FOREIGN KEY(queue_id,item_id) REFERENCES work_items(queue_id,item_id), FOREIGN KEY(queue_id,dependency_id) REFERENCES work_items(queue_id,item_id), CHECK(item_id != dependency_id)) STRICT",
    "CREATE INDEX work_dependency_dependents ON work_dependencies(queue_id,dependency_id,item_id)",
    "CREATE TABLE work_dependency_versions (queue_id TEXT NOT NULL, item_id TEXT NOT NULL, dependency_id TEXT NOT NULL, revision INTEGER NOT NULL, present INTEGER NOT NULL CHECK(present IN (0,1)), PRIMARY KEY(queue_id,item_id,dependency_id,revision), FOREIGN KEY(queue_id,item_id) REFERENCES work_items(queue_id,item_id), FOREIGN KEY(queue_id,dependency_id) REFERENCES work_items(queue_id,item_id)) STRICT",
    "CREATE INDEX work_dependency_reverse_history ON work_dependency_versions(queue_id,dependency_id,item_id,revision)",
    "CREATE INDEX work_dependency_mutations ON work_dependency_versions(queue_id,revision,item_id,dependency_id)",
    "CREATE TABLE work_mutations (queue_id TEXT NOT NULL REFERENCES work_queues(queue_id), mutation_id TEXT NOT NULL, revision INTEGER NOT NULL, record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 65536), PRIMARY KEY(queue_id,mutation_id), UNIQUE(queue_id,revision)) STRICT",
    "CREATE TABLE work_queue_bindings (session_id TEXT NOT NULL, workspace_id TEXT NOT NULL, queue_id TEXT NOT NULL REFERENCES work_queues(queue_id), PRIMARY KEY(session_id,workspace_id)) STRICT",
  ],
};
