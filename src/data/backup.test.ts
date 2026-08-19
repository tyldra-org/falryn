/**
 * Named user backup against a real migrated database.
 *
 * The copy is a second SQLite file, so inspect opens it without applying
 * migrations, and restore will not run while the live store is still open.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { backupName, createManualClock, instant, joinPath } from "../domain/index.ts";
import { createHostFileSystem, openBunSqlite } from "../integrations/index.ts";
import {
  collectLocalDiagnostics,
  createUserBackup,
  inspectUserBackup,
  restoreUserBackup,
} from "./backup.ts";
import {
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { PRODUCTION_MIGRATIONS } from "./sqlite-migrations.ts";
import { sqliteDatabasePath } from "./sqlite-store.ts";

afterEach(removeTemporaryRoots);

const NAME = backupName.from("daily");

describe("a named user backup", () => {
  test("copies the live database and inspects it without upgrading", async () => {
    const root = await makeTemporaryRoot("falryn-backup-");
    const store = await openProductStoreOrThrow(root);
    const databasePath = sqliteDatabasePath(root);
    if (databasePath === null) {
      throw new Error("expected a database path");
    }
    const options = {
      store,
      fileSystem: createHostFileSystem(),
      backupDirectory: root,
      databasePath,
      open: openBunSqlite,
      clock: createManualClock(instant(1_800_000_000_000)),
      migrations: PRODUCTION_MIGRATIONS,
    };

    const created = createUserBackup(options, NAME);
    expect(created.ok && created.value.schemaVersion).toBe(store.report.schemaVersion);

    const inspected = await inspectUserBackup(options, NAME);
    expect(inspected.ok && inspected.value.name).toBe(NAME);
    expect(inspected.ok && inspected.value.schemaVersion).toBe(store.report.schemaVersion);
    expect(inspected.ok && inspected.value.byteLength).toBeGreaterThan(0);

    const again = createUserBackup(options, NAME);
    expect(again.ok).toBe(false);

    const diagnostics = await collectLocalDiagnostics(options);
    expect(diagnostics.ok && diagnostics.value.schemaVersion).toBe(store.report.schemaVersion);
    expect(diagnostics.ok && diagnostics.value.sweep).toBeNull();

    await store.close();
  });

  test("refuses to restore while the live store is open", async () => {
    const root = await makeTemporaryRoot("falryn-backup-open-");
    const store = await openProductStoreOrThrow(root);
    const databasePath = sqliteDatabasePath(root);
    if (databasePath === null) {
      throw new Error("expected a database path");
    }
    const options = {
      store,
      fileSystem: createHostFileSystem(),
      backupDirectory: root,
      databasePath,
      open: openBunSqlite,
      clock: createManualClock(instant(1_800_000_000_000)),
      migrations: PRODUCTION_MIGRATIONS,
    };
    const created = createUserBackup(options, NAME);
    if (!created.ok) {
      throw new Error("expected a backup");
    }
    const restored = await restoreUserBackup(options, NAME);
    expect(restored.ok).toBe(false);
    expect(restored.ok || restored.error.code).toBe("live-store-open");
    await store.close();
  });

  test("restores after the live store closes, keeping the previous file", async () => {
    const root = await makeTemporaryRoot("falryn-backup-restore-");
    const store = await openProductStoreOrThrow(root);
    const databasePath = sqliteDatabasePath(root);
    if (databasePath === null) {
      throw new Error("expected a database path");
    }
    const options = {
      store,
      fileSystem: createHostFileSystem(),
      backupDirectory: root,
      databasePath,
      open: openBunSqlite,
      clock: createManualClock(instant(1_800_000_000_000)),
      migrations: PRODUCTION_MIGRATIONS,
    };
    const created = createUserBackup(options, NAME);
    if (!created.ok) {
      throw new Error("expected a backup");
    }
    await store.close();
    const restored = await restoreUserBackup(options, NAME);
    expect(restored.ok && restored.value.name).toBe(NAME);
    const previous = joinPath(root, "falryn.sqlite.previous");
    if (!previous.ok) {
      throw new Error("expected a previous-file path");
    }
    const stated = await options.fileSystem.stat(previous.value);
    expect(stated.ok && stated.value !== null).toBe(true);
  });

  test("refuses to restore when a previous file is already there", async () => {
    const root = await makeTemporaryRoot("falryn-backup-previous-");
    const store = await openProductStoreOrThrow(root);
    const databasePath = sqliteDatabasePath(root);
    if (databasePath === null) {
      throw new Error("expected a database path");
    }
    const options = {
      store,
      fileSystem: createHostFileSystem(),
      backupDirectory: root,
      databasePath,
      open: openBunSqlite,
      clock: createManualClock(instant(1_800_000_000_000)),
      migrations: PRODUCTION_MIGRATIONS,
    };
    const created = createUserBackup(options, NAME);
    if (!created.ok) {
      throw new Error("expected a backup");
    }
    await store.close();
    const previous = joinPath(root, "falryn.sqlite.previous");
    if (!previous.ok) {
      throw new Error("expected a previous-file path");
    }
    await Bun.write(previous.value, "keep");
    const restored = await restoreUserBackup(options, NAME);
    expect(restored.ok).toBe(false);
    expect(restored.ok || restored.error.code).toBe("filesystem");
  });

  test("reports cancelled rather than copying after abort", async () => {
    const root = await makeTemporaryRoot("falryn-backup-cancel-");
    const store = await openProductStoreOrThrow(root);
    const databasePath = sqliteDatabasePath(root);
    if (databasePath === null) {
      throw new Error("expected a database path");
    }
    const options = {
      store,
      fileSystem: createHostFileSystem(),
      backupDirectory: root,
      databasePath,
      open: openBunSqlite,
      clock: createManualClock(instant(1_800_000_000_000)),
      migrations: PRODUCTION_MIGRATIONS,
    };
    const signal = AbortSignal.abort();
    expect(createUserBackup(options, NAME, signal).ok).toBe(false);
    const inspected = await inspectUserBackup(options, NAME, signal);
    expect(inspected.ok).toBe(false);
    await store.close();
    const restored = await restoreUserBackup(options, NAME, signal);
    expect(restored.ok).toBe(false);
  });
});
