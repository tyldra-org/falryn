/**
 * Migration `0001`, checked against a real database and against the domain.
 *
 * A migration is the one artifact whose defects are only visible after they
 * have been applied to somebody's only copy, so these checks run it, inspect
 * what it produced, and pin the two places where SQL and TypeScript state the
 * same fact: the outcome vocabulary and the schema version.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  EFFECT_CERTAINTIES,
  INITIAL_SCHEMA_VERSION,
  type LocalPath,
  TERMINAL_OUTCOME_KINDS,
} from "../domain/index.ts";
import { ARTIFACT_SCHEMA_VERSION } from "./artifact-schema.ts";
import {
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { RUN_SCHEMA_VERSION } from "./run-schema.ts";
import { MIGRATION_0001, RECORD_SCHEMA_VERSION, RECORD_TABLES } from "./schema.ts";
import { PRODUCT_SCHEMA_VERSION, PRODUCT_TABLES } from "./sqlite-migrations.ts";
import { MIGRATION_TABLE } from "./sqlite-store.ts";

function temporaryRoot(): Promise<LocalPath> {
  return makeTemporaryRoot("falryn-schema-");
}

afterEach(removeTemporaryRoots);

describe("the declared migration", () => {
  test("names the outcome vocabulary the domain declares, and no other", () => {
    // Two spellings of the same closed union is how a database ends up
    // accepting an outcome this build cannot read back.
    const sql = MIGRATION_0001.statements.join("\n");
    for (const kind of TERMINAL_OUTCOME_KINDS) {
      expect(sql).toContain(`'${kind}'`);
    }
    for (const effect of EFFECT_CERTAINTIES) {
      expect(sql).toContain(`'${effect}'`);
    }
  });

  test("creates every table as STRICT, so a declared type is enforced", () => {
    const tables = MIGRATION_0001.statements.filter((statement) =>
      statement.startsWith("CREATE TABLE"),
    );

    expect(tables).toHaveLength(RECORD_TABLES.length);
    expect(tables.every((statement) => statement.endsWith(") STRICT"))).toBe(true);
  });

  test("is the version a migrated database reports", () => {
    expect(MIGRATION_0001.version).toBe(RECORD_SCHEMA_VERSION);
    expect(RECORD_SCHEMA_VERSION).toBeGreaterThan(INITIAL_SCHEMA_VERSION);
  });
});

describe("a fresh database", () => {
  test("migrates to the product schema version without a backup", async () => {
    const root = await temporaryRoot();
    const store = await openProductStoreOrThrow(root);

    expect(store.report.created).toBe(true);
    expect(store.report.schemaVersion).toBe(PRODUCT_SCHEMA_VERSION);
    expect(store.report.appliedThisRun).toEqual([
      RECORD_SCHEMA_VERSION,
      ARTIFACT_SCHEMA_VERSION,
      RUN_SCHEMA_VERSION,
    ]);
    // Nothing to lose: a database at version 0 holds no product row.
    expect(store.report.backupPath).toBeNull();
    await store.close();
  });

  test("holds every declared table and the runner's own bookkeeping", async () => {
    const root = await temporaryRoot();
    const store = await openProductStoreOrThrow(root);

    const tables = store.read(
      "SELECT name AS name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );

    expect(tables.ok && tables.value.map((row) => row.name)).toEqual(
      [MIGRATION_TABLE, ...PRODUCT_TABLES].sort(),
    );
    await store.close();
  });

  test("holds exactly the indexes the declared reads need", async () => {
    const root = await temporaryRoot();
    const store = await openProductStoreOrThrow(root);

    const indexes = store.read(
      `SELECT name AS name FROM sqlite_master
       WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
    );

    // Implicit indexes behind UNIQUE and PRIMARY KEY are excluded by
    // `sql IS NOT NULL`; what is listed here is what was declared on purpose.
    expect(indexes.ok && indexes.value.map((row) => row.name)).toEqual([
      "artifacts_by_digest",
      "artifacts_by_invocation",
      "artifacts_reserved",
      "invocations_by_turn",
      "model_attempts_by_turn",
      "sessions_by_workspace",
      "turns_by_session",
    ]);
    await store.close();
  });

  test("reopens at the same version without applying anything again", async () => {
    const root = await temporaryRoot();
    await (await openProductStoreOrThrow(root)).close();

    const reopened = await openProductStoreOrThrow(root);

    expect(reopened.report.created).toBe(false);
    expect(reopened.report.schemaVersion).toBe(PRODUCT_SCHEMA_VERSION);
    expect(reopened.report.appliedThisRun).toEqual([]);
    await reopened.close();
  });
});

describe("the events table", () => {
  test("enforces one event per sequence in a stream", async () => {
    const root = await temporaryRoot();
    const store = await openProductStoreOrThrow(root);
    const insert = `INSERT INTO events
      (event_id, stream_id, sequence, kind, schema_version, occurred_at, trace_id,
       idempotency_key, payload)
      VALUES ($eventId, 's', 1, 'session.started', 1, '2026-07-31T12:00:00.000Z', 't',
              $idempotencyKey, '{}')`;

    store.write((statements) => statements.run(insert, { eventId: "a", idempotencyKey: "key-a" }));
    const collision = store.write((statements) =>
      statements.run(insert, { eventId: "b", idempotencyKey: "key-b" }),
    );

    expect(collision).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });

  test("enforces one event per idempotency key in a stream", async () => {
    const root = await temporaryRoot();
    const store = await openProductStoreOrThrow(root);
    const insert = `INSERT INTO events
      (event_id, stream_id, sequence, kind, schema_version, occurred_at, trace_id,
       idempotency_key, payload)
      VALUES ($eventId, 's', $sequence, 'session.started', 1, '2026-07-31T12:00:00.000Z', 't',
              'key-a', '{}')`;

    store.write((statements) => statements.run(insert, { eventId: "a", sequence: 1 }));
    const reused = store.write((statements) =>
      statements.run(insert, { eventId: "b", sequence: 2 }),
    );

    expect(reused).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });
});

describe("the projection cursor table", () => {
  test("holds one cursor per projection and stream", async () => {
    const root = await temporaryRoot();
    const store = await openProductStoreOrThrow(root);
    const insert = `INSERT INTO projection_cursors
      (projection, stream_id, last_applied_sequence, schema_generation, updated_at)
      VALUES ('terminal-outcomes', 's', 1, 1, '2026-07-31T12:00:00.000Z')`;

    store.write((statements) => statements.run(insert));
    const duplicated = store.write((statements) => statements.run(insert));

    expect(duplicated).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });
});
