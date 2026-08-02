/**
 * Migration `0003`, checked against a real database.
 *
 * A migration's defects are only visible after it has been applied to
 * somebody's only copy, so these run it and inspect what it produced — in
 * particular the two things `ALTER TABLE` makes easy to get wrong: a column
 * that is not nullable, and rows written by an earlier migration that no longer
 * satisfy the table.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { LocalPath, SqliteStorePort } from "../domain/index.ts";
import {
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { MIGRATION_0003, RUN_SCHEMA_VERSION, RUNS_TABLE } from "./run-schema.ts";

afterEach(removeTemporaryRoots);

function open(): Promise<SqliteStorePort> {
  return makeTemporaryRoot("falryn-run-schema-").then((root: LocalPath) =>
    openProductStoreOrThrow(root),
  );
}

describe("the declared migration", () => {
  test("creates and adds, and alters no existing value", () => {
    const sql = MIGRATION_0003.statements.join("\n");
    expect(MIGRATION_0003.version).toBe(RUN_SCHEMA_VERSION);
    // Non-destructive is what lets the runner skip a pre-migration backup.
    expect(MIGRATION_0003.destructive).toBe(false);
    expect(sql).not.toMatch(/\b(DROP|DELETE\s+FROM|UPDATE)\b/i);
  });
});

describe("the runs table", () => {
  test("holds a run with no end time, which is the crash signal", async () => {
    const store = await open();

    const written = store.write((statements) =>
      statements.run(
        `INSERT INTO ${RUNS_TABLE} (run_id, started_at, ended_at, schema_version)
         VALUES ('r', '2026-07-31T12:00:00.000Z', NULL, 3)`,
      ),
    );

    expect(written.ok).toBe(true);
    await store.close();
  });

  test("refuses a second row under one run identity", async () => {
    const store = await open();
    const insert = `INSERT INTO ${RUNS_TABLE} (run_id, started_at, ended_at, schema_version)
      VALUES ('r', '2026-07-31T12:00:00.000Z', NULL, 3)`;
    store.write((statements) => statements.run(insert));

    const repeated = store.write((statements) => statements.run(insert));

    expect(repeated).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });

  test("refuses a schema version no migration could have produced", async () => {
    const store = await open();

    const written = store.write((statements) =>
      statements.run(
        `INSERT INTO ${RUNS_TABLE} (run_id, started_at, ended_at, schema_version)
         VALUES ('r', '2026-07-31T12:00:00.000Z', NULL, 0)`,
      ),
    );

    expect(written).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });
});

describe("the artifact's link to its run", () => {
  test("is nullable, because rows written by migration 0002 predate every run", async () => {
    const store = await open();

    const written = store.write((statements) =>
      statements.run(
        `INSERT INTO artifacts (artifact_id, digest, media_type, encoding, byte_length,
           sensitivity, origin, invocation_id, created_at, finalized_at, availability)
         VALUES ('a1', 'sha-256:${"a".repeat(64)}', 'text/plain', 'identity', 4,
           'user-content', 'tool-output', NULL, '2026-07-31T12:00:00.000Z',
           '2026-07-31T12:00:01.000Z', 'available')`,
      ),
    );

    expect(written.ok).toBe(true);
    const rows = store.read("SELECT run_id AS runId FROM artifacts WHERE artifact_id = 'a1'");
    expect(rows.ok && rows.value[0]?.runId).toBeNull();
    await store.close();
  });

  test("refuses a run this database does not hold", async () => {
    const store = await open();

    const written = store.write((statements) =>
      statements.run(
        `INSERT INTO artifacts (artifact_id, digest, media_type, encoding, byte_length,
           sensitivity, origin, invocation_id, created_at, finalized_at, availability, run_id)
         VALUES ('a1', 'sha-256:${"a".repeat(64)}', 'text/plain', 'identity', 4,
           'user-content', 'tool-output', NULL, '2026-07-31T12:00:00.000Z',
           '2026-07-31T12:00:01.000Z', 'available', 'no-such-run')`,
      ),
    );

    // `foreign_keys = ON` is applied at open, so the link is real rather than
    // documentation.
    expect(written).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });

  test("is indexed only over the rows recovery actually reads", async () => {
    const store = await open();

    const index = store.read(
      "SELECT sql AS sql FROM sqlite_master WHERE type = 'index' AND name = 'artifacts_reserved'",
    );

    // Partial on purpose: almost every row in an ordinary database is
    // `available`, so an index over the whole column would be mostly dead
    // weight for the one read that visits it.
    expect(index.ok && String(index.value[0]?.sql)).toContain("WHERE availability = 'reserved'");
    await store.close();
  });
});
