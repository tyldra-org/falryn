/** Bounded captured-process ownership, output references, and settlement outbox (#157). */
import type { Migration } from "../../domain/storage/index.ts";

export const PROCESS_TASKS_TABLE = "process_tasks";
export const PROCESS_TASK_CHUNKS_TABLE = "process_task_chunks";
export const PROCESS_TASK_WAKES_TABLE = "process_task_wakes";
export const PROCESS_TASK_ARTIFACTS_TABLE = "process_task_artifacts";
export const ARTIFACT_GC_CLAIMS_TABLE = "artifact_gc_claims";

export const MIGRATION_0011: Migration = {
  version: 11,
  name: "create-process-task-ownership",
  destructive: false,
  statements: [
    `CREATE TABLE ${PROCESS_TASKS_TABLE} (
      task_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      snapshot TEXT NOT NULL CHECK (length(CAST(snapshot AS BLOB)) <= 16384),
      PRIMARY KEY (task_id, generation),
      UNIQUE (task_id)
    ) STRICT`,
    `CREATE TRIGGER process_task_capacity BEFORE INSERT ON ${PROCESS_TASKS_TABLE}
      WHEN (SELECT COUNT(*) FROM ${PROCESS_TASKS_TABLE}) >= 256
      BEGIN SELECT RAISE(ABORT, 'process-task-capacity'); END`,
    `CREATE TABLE ${PROCESS_TASK_CHUNKS_TABLE} (
      task_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr')),
      offset INTEGER NOT NULL CHECK (offset >= 0),
      byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 65536),
      artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
      digest TEXT NOT NULL,
      PRIMARY KEY (task_id, generation, stream, offset),
      FOREIGN KEY (task_id, generation) REFERENCES ${PROCESS_TASKS_TABLE}(task_id, generation) ON DELETE CASCADE,
      CHECK (offset + byte_length <= 8388608)
    ) STRICT`,
    `CREATE TABLE ${PROCESS_TASK_WAKES_TABLE} (
      task_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      notification_id TEXT NOT NULL UNIQUE,
      terminal_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'acknowledged', 'unavailable')),
      PRIMARY KEY (task_id, generation),
      FOREIGN KEY (task_id, generation) REFERENCES ${PROCESS_TASKS_TABLE}(task_id, generation) ON DELETE CASCADE
    ) STRICT`,
    `CREATE TABLE ${PROCESS_TASK_ARTIFACTS_TABLE} (
      artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
      PRIMARY KEY (artifact_id, task_id, generation)
    ) STRICT`,
    `CREATE TABLE ${ARTIFACT_GC_CLAIMS_TABLE} (
      digest TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      owner_id TEXT NOT NULL
    ) STRICT`,
    `CREATE TRIGGER artifact_gc_claim_capacity BEFORE INSERT ON ${ARTIFACT_GC_CLAIMS_TABLE}
      WHEN (SELECT COUNT(*) FROM ${ARTIFACT_GC_CLAIMS_TABLE}) >= 256
      BEGIN SELECT RAISE(ABORT, 'artifact-gc-claim-capacity'); END`,
  ],
};
