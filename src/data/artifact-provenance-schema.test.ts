/**
 * Migration `0004`, checked against a real database.
 */

import { afterEach, describe, expect, test } from "bun:test";

import type { LocalPath, SqliteStorePort } from "../domain/index.ts";
import {
  ARTIFACT_PROVENANCE_SCHEMA_VERSION,
  ARTIFACT_TRANSFORMATIONS_TABLE,
  MIGRATION_0004,
} from "./artifact-provenance-schema.ts";
import { MIGRATION_0002 } from "./artifact-schema.ts";
import {
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { MIGRATION_0003 } from "./run-schema.ts";
import { MIGRATION_0001 } from "./schema.ts";

afterEach(removeTemporaryRoots);

function open(): Promise<SqliteStorePort> {
  return makeTemporaryRoot("falryn-artifact-provenance-schema-").then((root: LocalPath) =>
    openProductStoreOrThrow(root),
  );
}

describe("the declared migration", () => {
  test("creates and indexes, and alters no existing value", () => {
    const sql = MIGRATION_0004.statements.join("\n");
    expect(MIGRATION_0004.version).toBe(ARTIFACT_PROVENANCE_SCHEMA_VERSION);
    expect(MIGRATION_0004.destructive).toBe(false);
    expect(sql).not.toMatch(/\b(DROP|DELETE\s+FROM|UPDATE)\b/i);
  });
});

describe("the provenance table", () => {
  test("exists after a product open", async () => {
    const store = await open();
    const rows = store.read(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name",
      { name: ARTIFACT_TRANSFORMATIONS_TABLE },
    );
    expect(rows.ok && rows.value).toEqual([{ name: ARTIFACT_TRANSFORMATIONS_TABLE }]);
    await store.close();
  });

  test("applies onto a database that stopped at run identity", async () => {
    const root = await makeTemporaryRoot("falryn-artifact-provenance-upgrade-");
    const first = await openProductStoreOrThrow(root, {
      migrations: [MIGRATION_0001, MIGRATION_0002, MIGRATION_0003],
    });
    expect(first.report.schemaVersion).toBe(3);
    expect(first.report.backupPath).toBeNull();
    await first.close();

    const upgraded = await openProductStoreOrThrow(root);
    expect(upgraded.report.created).toBe(false);
    expect(upgraded.report.appliedThisRun).toEqual([ARTIFACT_PROVENANCE_SCHEMA_VERSION]);
    expect(upgraded.report.schemaVersion).toBe(ARTIFACT_PROVENANCE_SCHEMA_VERSION);
    expect(upgraded.report.backupPath).toBeNull();
    const rows = upgraded.read(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name",
      { name: ARTIFACT_TRANSFORMATIONS_TABLE },
    );
    expect(rows.ok && rows.value).toEqual([{ name: ARTIFACT_TRANSFORMATIONS_TABLE }]);
    await upgraded.close();
  });
});
