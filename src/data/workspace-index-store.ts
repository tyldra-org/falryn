/**
 * SQLite-backed workspace index store (#93).
 *
 * Opens a dedicated index database, replaces generations atomically, and
 * exposes {@link WorkspaceIndexPort}.snapshot for the #64 query seam.
 */

import {
  type ClockPort,
  err,
  type IndexLifecycle,
  type IndexRecordKind,
  type LocalPath,
  ok,
  type Result,
  type SqliteOpener,
  type SqliteStorePort,
  WORKSPACE_INDEX_SCHEMA,
  type WorkspaceIndexError,
  type WorkspaceIndexGeneration,
  type WorkspaceIndexPort,
  type WorkspaceIndexRecord,
} from "../domain/index.ts";
import { openSqliteStore } from "./sqlite-store.ts";
import {
  WORKSPACE_INDEX_GENERATIONS_TABLE,
  WORKSPACE_INDEX_MIGRATIONS,
  WORKSPACE_INDEX_RECORDS_TABLE,
} from "./workspace-index-schema.ts";

export type WorkspaceIndexStore = WorkspaceIndexPort & {
  readonly databasePath: LocalPath;
  rebuild(
    generation: WorkspaceIndexGeneration,
    signal?: AbortSignal,
  ): Promise<Result<WorkspaceIndexGeneration, WorkspaceIndexError>>;
  close(): Promise<void>;
};

export type WorkspaceIndexStoreOptions = {
  readonly open: SqliteOpener;
  readonly clock: ClockPort;
  readonly databasePath: LocalPath;
  readonly backupDirectory: LocalPath;
};

function mapStoreUnavailable(reason: string): WorkspaceIndexError {
  if (reason.includes("corrupt")) {
    return { code: "index-corrupt" };
  }
  return { code: "unavailable" };
}

function isLifecycle(value: string): value is IndexLifecycle {
  return (
    value === "absent" ||
    value === "inventorying" ||
    value === "building" ||
    value === "ready" ||
    value === "updating" ||
    value === "stale" ||
    value === "degraded" ||
    value === "corrupt" ||
    value === "unavailable"
  );
}

function isRecordKind(value: string): value is IndexRecordKind {
  return value === "symbol" || value === "heading" || value === "chunk";
}

async function readCurrentGeneration(
  store: SqliteStorePort,
  signal?: AbortSignal,
): Promise<Result<WorkspaceIndexGeneration, WorkspaceIndexError>> {
  if (signal?.aborted === true) {
    return err({ code: "cancelled" });
  }
  const generationRow = store.read(
    `SELECT id, schema, lifecycle
       FROM ${WORKSPACE_INDEX_GENERATIONS_TABLE}
      ORDER BY created_at DESC
      LIMIT 1`,
  );
  if (!generationRow.ok) {
    return err(mapStoreUnavailable(generationRow.error.code));
  }
  const head = generationRow.value[0];
  if (head === undefined) {
    return err({ code: "index-absent" });
  }
  const id = head.id;
  const schema = head.schema;
  const lifecycle = head.lifecycle;
  if (typeof id !== "string" || typeof schema !== "string" || typeof lifecycle !== "string") {
    return err({ code: "index-corrupt" });
  }
  if (!isLifecycle(lifecycle)) {
    return err({ code: "index-corrupt" });
  }
  const recordRows = store.read(
    `SELECT logical, kind, name, text, start_line AS startLine, end_line AS endLine, revision
       FROM ${WORKSPACE_INDEX_RECORDS_TABLE}
      WHERE generation_id = $id
      ORDER BY logical ASC, start_line ASC, kind ASC, name ASC`,
    { id },
  );
  if (!recordRows.ok) {
    return err(mapStoreUnavailable(recordRows.error.code));
  }
  const records: WorkspaceIndexRecord[] = [];
  for (const row of recordRows.value) {
    if (
      typeof row.logical !== "string" ||
      typeof row.kind !== "string" ||
      typeof row.name !== "string" ||
      typeof row.text !== "string" ||
      typeof row.startLine !== "number" ||
      typeof row.endLine !== "number" ||
      typeof row.revision !== "string" ||
      !isRecordKind(row.kind)
    ) {
      return err({ code: "index-corrupt" });
    }
    records.push({
      logical: row.logical,
      kind: row.kind,
      name: row.name,
      text: row.text,
      startLine: row.startLine,
      endLine: row.endLine,
      revision: row.revision,
    });
  }
  return ok({
    id,
    schema: schema.length > 0 ? schema : WORKSPACE_INDEX_SCHEMA,
    lifecycle,
    records,
  });
}

export async function openWorkspaceIndexStore(
  options: WorkspaceIndexStoreOptions,
  signal?: AbortSignal,
): Promise<Result<WorkspaceIndexStore, WorkspaceIndexError>> {
  const opened = await openSqliteStore(
    {
      open: options.open,
      clock: options.clock,
      databasePath: options.databasePath,
      backupDirectory: options.backupDirectory,
      migrations: WORKSPACE_INDEX_MIGRATIONS,
    },
    signal,
  );
  if (!opened.ok) {
    return err(mapStoreUnavailable(opened.error.code));
  }
  const store = opened.value;

  const port: WorkspaceIndexStore = {
    databasePath: options.databasePath,
    async snapshot(_root, snapshotSignal) {
      return readCurrentGeneration(store, snapshotSignal);
    },
    async rebuild(generation, rebuildSignal) {
      if (rebuildSignal?.aborted === true) {
        return err({ code: "cancelled" });
      }
      if (generation.schema !== WORKSPACE_INDEX_SCHEMA) {
        return err({ code: "unavailable" });
      }
      const written = store.write((statements) => {
        statements.run(`DELETE FROM ${WORKSPACE_INDEX_RECORDS_TABLE}`);
        statements.run(`DELETE FROM ${WORKSPACE_INDEX_GENERATIONS_TABLE}`);
        statements.run(
          `INSERT INTO ${WORKSPACE_INDEX_GENERATIONS_TABLE}
            (id, schema, lifecycle, created_at)
           VALUES ($id, $schema, $lifecycle, $createdAt)`,
          {
            id: generation.id,
            schema: generation.schema,
            lifecycle: generation.lifecycle,
            createdAt: options.clock.now(),
          },
        );
        for (const record of generation.records) {
          statements.run(
            `INSERT INTO ${WORKSPACE_INDEX_RECORDS_TABLE}
              (generation_id, logical, kind, name, text, start_line, end_line, revision)
             VALUES ($generationId, $logical, $kind, $name, $text, $startLine, $endLine, $revision)`,
            {
              generationId: generation.id,
              logical: record.logical,
              kind: record.kind,
              name: record.name,
              text: record.text,
              startLine: record.startLine,
              endLine: record.endLine,
              revision: record.revision,
            },
          );
        }
        return undefined;
      }, rebuildSignal);
      if (!written.ok) {
        return err(mapStoreUnavailable(written.error.code));
      }
      return ok(generation);
    },
    async close() {
      await store.close();
    },
  };

  return ok(port);
}
