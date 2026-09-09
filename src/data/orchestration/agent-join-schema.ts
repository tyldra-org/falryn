import type { Migration } from "../../domain/storage/index.ts";

/** SQL expressions are supplied only by this adapter, never by a model or user. */
export const pendingJoinReference = (taskId: string, generation: string) =>
  `EXISTS(SELECT 1 FROM agent_joins j, json_each(j.record,'$.input.children') child WHERE j.released=0 AND json_extract(j.record,'$.integration') IS NULL AND json_extract(child.value,'$.task.taskId')=${taskId} AND json_extract(child.value,'$.task.generation')=${generation})`;

export const AGENT_JOIN_TABLES = [
  "agent_parents",
  "agent_children",
  "agent_joins",
  "agent_join_revisions",
  "process_task_seals",
] as const;
export const MIGRATION_0016: Migration = {
  version: 16,
  name: "parent-owned-agent-joins",
  destructive: false,
  statements: [
    "CREATE TABLE agent_parents (owner TEXT PRIMARY KEY, closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)), completion TEXT CHECK(length(CAST(completion AS BLOB))<=65536)) STRICT",
    "CREATE TABLE agent_children (task_id TEXT NOT NULL, generation INTEGER NOT NULL, owner TEXT NOT NULL REFERENCES agent_parents(owner), record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=65536), integrated INTEGER NOT NULL DEFAULT 0 CHECK(integrated IN (0,1,2)), PRIMARY KEY(task_id,generation)) STRICT",
    "CREATE INDEX agent_children_owner ON agent_children(owner)",
    "CREATE TABLE agent_joins (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES agent_parents(owner), revision INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0 CHECK(released IN (0,1)), record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=65536)) STRICT",
    "CREATE INDEX agent_joins_owner ON agent_joins(owner)",
    "CREATE TABLE agent_join_revisions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL REFERENCES agent_joins(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 3), record TEXT NOT NULL CHECK(length(CAST(record AS BLOB))<=65536), UNIQUE(id,revision)) STRICT",
    "CREATE TABLE process_task_seals (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, generation TEXT NOT NULL, UNIQUE(task_id,generation), FOREIGN KEY(task_id,generation) REFERENCES process_tasks(task_id,generation) ON DELETE CASCADE) STRICT",
    // Existing terminal tasks predate join registration. Their order is journal order, never time.
    "INSERT INTO process_task_seals(task_id,generation) SELECT t.task_id,t.generation FROM process_tasks t JOIN process_task_wakes w USING(task_id,generation) JOIN events e ON e.event_id=w.terminal_event_id ORDER BY e.rowid",
    "CREATE TRIGGER process_task_seal_order AFTER INSERT ON process_task_wakes BEGIN INSERT INTO process_task_seals(task_id,generation) VALUES(NEW.task_id,NEW.generation); END",
    `CREATE TRIGGER agent_unjoined_cleanup BEFORE DELETE ON process_tasks WHEN EXISTS(SELECT 1 FROM agent_children c JOIN agent_parents p USING(owner) WHERE json_extract(c.record,'$.handle.task.taskId')=OLD.task_id AND json_extract(c.record,'$.handle.task.generation')=OLD.generation AND c.integrated=0 AND p.closed=0 AND json_extract(OLD.snapshot,'$.attachment')='foreground') OR ${pendingJoinReference("OLD.task_id", "OLD.generation")} BEGIN SELECT RAISE(ABORT,'agent-unjoined'); END`,
  ],
};
