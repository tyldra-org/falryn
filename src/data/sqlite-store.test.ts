import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createManualClock,
  instant,
  type LocalPath,
  localPath,
  MIN_BUSY_TIMEOUT_MS,
  type Migration,
  migrationChecksum,
  type SqliteStorePort,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import { MIGRATION_TABLE, openSqliteStore, sqliteDatabasePath } from "./sqlite-store.ts";

/**
 * Every test gets its own root.
 *
 * Never the developer's real state root: these tests create, corrupt, and
 * remove databases, and a run that reached the real one would destroy work.
 */
const roots: string[] = [];

async function temporaryRoot(): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), "falryn-sqlite-"));
  roots.push(created);
  return localPath(created);
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
});

function databasePath(root: LocalPath): LocalPath {
  const path = sqliteDatabasePath(root);
  if (path === null) {
    throw new Error("the temporary root did not produce a database path");
  }
  return path;
}

type OpenOverrides = {
  readonly signal?: AbortSignal;
  readonly busyTimeoutMs?: number;
  readonly create?: boolean;
};

function openStore(
  root: LocalPath,
  migrations: readonly Migration[],
  overrides: OpenOverrides = {},
) {
  return openSqliteStore(
    {
      open: openBunSqlite,
      clock: createManualClock(instant(1_700_000_000_000)),
      databasePath: databasePath(root),
      backupDirectory: root,
      migrations,
      ...(overrides.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: overrides.busyTimeoutMs }),
      ...(overrides.create === undefined ? {} : { create: overrides.create }),
    },
    overrides.signal,
  );
}

async function openOrThrow(
  root: LocalPath,
  migrations: readonly Migration[],
  overrides: OpenOverrides = {},
): Promise<SqliteStorePort> {
  const opened = await openStore(root, migrations, overrides);
  if (!opened.ok) {
    throw new Error(`expected the store to open: ${opened.error.code}`);
  }
  return opened.value;
}

function createTable(version: number, table: string): Migration {
  return {
    version,
    name: `create-${table}`,
    statements: [`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT`],
    destructive: false,
  };
}

const ONE_TABLE: readonly Migration[] = [createTable(1, "alpha")];
const THREE_TABLES: readonly Migration[] = [
  createTable(1, "alpha"),
  createTable(2, "beta"),
  createTable(3, "gamma"),
];

function tableNames(store: SqliteStorePort): readonly string[] {
  const rows = store.read("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
  if (!rows.ok) {
    throw new Error(`expected a readable schema: ${rows.error.code}`);
  }
  return rows.value.map((row) => String(row.name));
}

describe("a fresh database", () => {
  test("is created, migrated, integrity-checked, and closed leaving one file", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);

    expect(store.report.created).toBe(true);
    expect(store.report.schemaVersion).toBe(1);
    expect(store.report.appliedThisRun).toEqual([1]);
    expect(store.report.backupPath).toBeNull();
    expect(tableNames(store)).toContain("alpha");

    const closed = await store.close();
    expect(closed.persistentWalDisabled).toBe(true);
    expect(closed.checkpointed).toBe(true);
    expect(closed.closed).toBe(true);
    expect(closed.failures).toEqual([]);

    // One file. A leftover `-wal` or `-shm` is then a real signal of a crashed
    // run rather than ordinary debris that retention has to explain.
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
  });

  test("records the runner's own bookkeeping with a checksum of the applied SQL", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);

    expect(store.report.applied).toEqual([
      {
        version: 1,
        name: "create-alpha",
        checksum: migrationChecksum(ONE_TABLE[0]?.statements ?? []),
        appliedAt: 1_700_000_000_000,
      },
    ]);
    expect(tableNames(store)).toContain(MIGRATION_TABLE);

    await store.close();
  });

  test("copies itself with VACUUM INTO to a path that is not already there", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);
    const target = localPath(`${root}/copy.sqlite`);

    expect(store.backupInto(target).ok).toBe(true);
    expect(store.backupInto(target).ok).toBe(false);
    await store.close();
  });

  test("closes at schema version zero when the build declares no migration", async () => {
    // The v0.1 production path exactly: a database, a bookkeeping table, an
    // integrity check, and nothing else.
    const root = await temporaryRoot();
    const store = await openOrThrow(root, []);

    expect(store.report.schemaVersion).toBe(0);
    expect(store.report.applied).toEqual([]);
    expect(tableNames(store)).toEqual([MIGRATION_TABLE]);

    await store.close();
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
  });

  test("is not created when creation is refused", async () => {
    const root = await temporaryRoot();
    const opened = await openStore(root, ONE_TABLE, { create: false });

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.code).toBe("unavailable");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("an existing database", () => {
  test("opens as a no-op when it is already current", async () => {
    const root = await temporaryRoot();
    await (await openOrThrow(root, ONE_TABLE)).close();

    const reopened = await openOrThrow(root, ONE_TABLE);
    expect(reopened.report.created).toBe(false);
    expect(reopened.report.schemaVersion).toBe(1);
    expect(reopened.report.appliedThisRun).toEqual([]);
    await reopened.close();
  });

  test("migrates forward through every intermediate step", async () => {
    const root = await temporaryRoot();
    await (await openOrThrow(root, ONE_TABLE)).close();

    const upgraded = await openOrThrow(root, THREE_TABLES);
    expect(upgraded.report.appliedThisRun).toEqual([2, 3]);
    expect(upgraded.report.applied.map((entry) => entry.version)).toEqual([1, 2, 3]);
    // Every step ran, rather than the newest one being applied on its own.
    expect(tableNames(upgraded)).toEqual(expect.arrayContaining(["alpha", "beta", "gamma"]));
    await upgraded.close();
  });

  test("is refused when it records a version this build has no migration for", async () => {
    const root = await temporaryRoot();
    await (await openOrThrow(root, THREE_TABLES)).close();

    const downgraded = await openStore(root, ONE_TABLE);

    expect(downgraded.ok).toBe(false);
    expect(!downgraded.ok && downgraded.error).toMatchObject({
      code: "schema-too-new",
      recordedVersion: 3,
      applicationVersion: 1,
      effect: "none",
    });
    // Refused, never downgraded, and the only usable copy is still there.
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
  });

  test("is refused when applied SQL no longer matches this build", async () => {
    const root = await temporaryRoot();
    await (await openOrThrow(root, ONE_TABLE)).close();

    const rewritten: readonly Migration[] = [
      {
        version: 1,
        name: "create-alpha",
        statements: ["CREATE TABLE alpha (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT"],
        destructive: false,
      },
    ];
    const opened = await openStore(root, rewritten);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toMatchObject({
      code: "checksum-mismatch",
      version: 1,
      declaredChecksum: migrationChecksum(rewritten[0]?.statements ?? []),
      effect: "none",
    });
  });
});

describe("a defective migration set", () => {
  test("is refused at load, before anything opens a file", async () => {
    const root = await temporaryRoot();
    const opened = await openStore(root, [createTable(1, "alpha"), createTable(3, "gamma")]);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.code).toBe("invalid-migration-set");
    expect(
      !opened.ok && opened.error.code === "invalid-migration-set" && opened.error.issues,
    ).toEqual([{ kind: "migration-set", code: "version-gap", version: 3, name: "create-gamma" }]);
    // Nothing was created: a defective build never reaches a user's database.
    expect(await readdir(root)).toEqual([]);
  });
});

describe("a migration that fails", () => {
  const broken: readonly Migration[] = [
    createTable(1, "alpha"),
    {
      version: 2,
      name: "half-valid",
      statements: ["CREATE TABLE beta (id INTEGER PRIMARY KEY) STRICT", "THIS IS NOT SQL"],
      destructive: false,
    },
  ];

  test("rolls back and leaves the recorded version unchanged", async () => {
    const root = await temporaryRoot();
    const opened = await openStore(root, broken);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toMatchObject({
      code: "migration-failed",
      version: 2,
      name: "half-valid",
      recordedVersion: 1,
      appliedVersions: [1],
      backupPath: null,
      // Version 1 committed, version 2 did not: a known subset happened.
      effect: "partial",
    });

    const reopened = await openOrThrow(root, [createTable(1, "alpha")]);
    expect(reopened.report.schemaVersion).toBe(1);
    // The first statement of the failed migration rolled back with the rest.
    expect(tableNames(reopened)).not.toContain("beta");
    await reopened.close();
  });

  test("reports no effect when the first migration is the one that failed", async () => {
    const root = await temporaryRoot();
    const opened = await openStore(
      root,
      [broken[1] as Migration].map((step) => ({
        ...step,
        version: 1,
      })),
    );

    expect(!opened.ok && opened.error).toMatchObject({
      code: "migration-failed",
      recordedVersion: 0,
      appliedVersions: [],
      effect: "none",
    });
  });
});

describe("an interrupted migration", () => {
  test("names the recorded version and the applied set, and deletes nothing", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();

    // Aborts once the first migration has been recorded, so the run stops
    // between steps rather than inside one.
    const migrations: readonly Migration[] = [
      {
        ...createTable(1, "alpha"),
        statements: ["CREATE TABLE alpha (id INTEGER PRIMARY KEY) STRICT"],
      },
      createTable(2, "beta"),
    ];

    const store = await openOrThrow(root, [migrations[0] as Migration]);
    await store.close();

    controller.abort();
    const opened = await openStore(root, migrations, { signal: controller.signal });

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toMatchObject({
      code: "cancelled",
      effect: "none",
    });
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
  });

  test("reports a partial effect once at least one step has committed", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    let applied = 0;

    const migrations: readonly Migration[] = [
      createTable(1, "alpha"),
      createTable(2, "beta"),
      createTable(3, "gamma"),
    ];

    // The clock is the only thing the runner calls between migrations, so
    // aborting from it stops the run exactly between two committed steps.
    const clock = createManualClock(instant(1_700_000_000_000));
    const opened = await openSqliteStore(
      {
        open: openBunSqlite,
        clock: {
          now: () => {
            applied += 1;
            if (applied === 2) {
              controller.abort();
            }
            return clock.now();
          },
          waitUntil: (at, signal) => clock.waitUntil(at, signal),
        },
        databasePath: databasePath(root),
        backupDirectory: root,
        migrations,
      },
      controller.signal,
    );

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toMatchObject({
      code: "migration-interrupted",
      recordedVersion: 2,
      appliedVersions: [1, 2],
      backupPath: null,
      effect: "partial",
    });

    // Nothing was deleted: the interrupted database is still the only copy and
    // is diagnosable exactly where it stopped.
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
    const reopened = await openOrThrow(root, [
      migrations[0] as Migration,
      migrations[1] as Migration,
    ]);
    expect(reopened.report.schemaVersion).toBe(2);
    await reopened.close();
  });
});

describe("a destructive migration", () => {
  const destructive: readonly Migration[] = [
    createTable(1, "alpha"),
    {
      version: 2,
      name: "drop-alpha",
      statements: ["DROP TABLE alpha"],
      destructive: true,
    },
  ];

  test("takes a bounded backup in the state root before it runs", async () => {
    const root = await temporaryRoot();
    await (await openOrThrow(root, [destructive[0] as Migration])).close();

    const upgraded = await openOrThrow(root, destructive);
    expect(upgraded.report.backupPath).toBe(localPath(`${root}/falryn-backup-v1.sqlite`));
    await upgraded.close();

    const entries = (await readdir(root)).sort();
    expect(entries).toEqual(["falryn-backup-v1.sqlite", "falryn.sqlite"]);

    // The backup is a real database still recording the version it was taken
    // from, so the pre-migration state is recoverable rather than merely a file.
    const backup = openBunSqlite({
      path: localPath(`${root}/falryn-backup-v1.sqlite`),
      create: false,
    });
    if (!backup.ok) {
      throw new Error("expected the backup to be a usable database");
    }
    expect(backup.value.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`)).toEqual([
      { version: 1 },
    ]);
    await backup.value.close();
  });

  test("takes no backup on a database that has nothing to lose", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, destructive);

    expect(store.report.backupPath).toBeNull();
    await store.close();
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
  });
});

describe("write transactions", () => {
  test("commit through the immediate boundary", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);

    const written = store.write((statements) =>
      statements.run("INSERT INTO alpha (id, label) VALUES ($id, $label)", {
        id: 1,
        label: "first",
      }),
    );

    expect(written.ok).toBe(true);
    expect(written.ok && written.value.value.changes).toBe(1);
    expect(written.ok && written.value.cancelledAfterCommit).toBe(false);
    await store.close();
  });

  test("roll back entirely when the work throws", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);

    store.write((statements) => {
      statements.run("INSERT INTO alpha (id, label) VALUES (1, 'kept?')");
      statements.run("INSERT INTO alpha (id, label) VALUES (1, 'duplicate')");
      return null;
    });

    const rows = store.read("SELECT id FROM alpha");
    expect(rows.ok && rows.value).toEqual([]);
    await store.close();
  });

  test("report a rejected statement as the caller's defect, not a broken disk", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);

    const written = store.write((statements) =>
      statements.run("INSERT INTO alpha (id, label) VALUES (1, NULL)"),
    );

    expect(written.ok).toBe(false);
    expect(!written.ok && written.error).toMatchObject({
      code: "statement-rejected",
      effect: "none",
    });
    await store.close();
  });

  test("refuse a mis-named bound parameter instead of binding null", async () => {
    // What strict mode buys: without it this stores a null label and the
    // failure surfaces days later as missing data.
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);

    const written = store.write((statements) =>
      statements.run("INSERT INTO alpha (id, label) VALUES ($id, $label)", {
        id: 1,
        labell: "typo",
      }),
    );

    expect(written.ok).toBe(false);
    await store.close();
  });

  test("refuse to begin once cancellation has been requested", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);
    const controller = new AbortController();
    controller.abort();

    const written = store.write(
      (statements) => statements.run("INSERT INTO alpha (id, label) VALUES (1, 'never')"),
      controller.signal,
    );

    expect(written.ok).toBe(false);
    expect(!written.ok && written.error).toMatchObject({
      code: "cancelled",
      operation: "transaction",
      effect: "none",
    });
    // `cancelled` means "did not commit", and it did not.
    const rows = store.read("SELECT id FROM alpha");
    expect(rows.ok && rows.value).toEqual([]);
    await store.close();
  });

  test("keep a commit that finished before cancellation arrived", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);
    const controller = new AbortController();

    const written = store.write((statements) => {
      const outcome = statements.run("INSERT INTO alpha (id, label) VALUES (1, 'kept')");
      controller.abort();
      return outcome;
    }, controller.signal);

    expect(written.ok).toBe(true);
    // Reported, not undone. Calling this `cancelled` would say nothing happened
    // when a row was written.
    expect(written.ok && written.value.cancelledAfterCommit).toBe(true);
    const rows = store.read("SELECT label FROM alpha");
    expect(rows.ok && rows.value).toEqual([{ label: "kept" }]);
    await store.close();
  });
});

describe("contention with a second connection", () => {
  test("waits the busy timeout and then reports busy rather than hanging", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE, { busyTimeoutMs: MIN_BUSY_TIMEOUT_MS });

    const second = openBunSqlite({ path: databasePath(root), create: false });
    if (!second.ok) {
      throw new Error("expected the second connection to open");
    }
    second.value.pragma(`busy_timeout = ${MIN_BUSY_TIMEOUT_MS}`);
    second.value.run("BEGIN IMMEDIATE");

    const started = Date.now();
    const written = store.write((statements) =>
      statements.run("INSERT INTO alpha (id, label) VALUES (1, 'contended')"),
    );
    const waited = Date.now() - started;

    expect(written.ok).toBe(false);
    expect(!written.ok && written.error).toMatchObject({ code: "busy", effect: "none" });
    expect(waited).toBeGreaterThanOrEqual(MIN_BUSY_TIMEOUT_MS - 20);

    second.value.run("ROLLBACK");
    await second.value.close();
    await store.close();
  });

  test("refuses a concurrent migration rather than applying it twice", async () => {
    const root = await temporaryRoot();
    await (await openOrThrow(root, ONE_TABLE)).close();

    const holder = openBunSqlite({ path: databasePath(root), create: false });
    if (!holder.ok) {
      throw new Error("expected the holding connection to open");
    }
    holder.value.pragma(`busy_timeout = ${MIN_BUSY_TIMEOUT_MS}`);
    holder.value.run("BEGIN IMMEDIATE");

    const contended = await openStore(root, THREE_TABLES, {
      busyTimeoutMs: MIN_BUSY_TIMEOUT_MS,
    });

    expect(contended.ok).toBe(false);
    expect(!contended.ok && contended.error).toMatchObject({ code: "busy" });

    holder.value.run("ROLLBACK");
    await holder.value.close();
  });
});

describe("a database that cannot be used", () => {
  test("reports an unwritable state root rather than creating nothing quietly", async () => {
    if (process.getuid?.() === 0) {
      // Root ignores the mode bits, so the condition cannot be produced.
      return;
    }
    const root = await temporaryRoot();
    await chmod(root, 0o500);

    const opened = await openStore(root, ONE_TABLE);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toMatchObject({ code: "unavailable" });
  });

  test("refuses a file that is not a database and deletes nothing", async () => {
    const root = await temporaryRoot();
    const path = databasePath(root);
    await writeFile(path, "this is not a database, it is a note\n");

    const opened = await openStore(root, ONE_TABLE);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.code).toBe("unavailable");
    // The bytes someone put there are still theirs.
    expect(await readFile(path, "utf8")).toBe("this is not a database, it is a note\n");
  });
});

describe("a closed store", () => {
  test("refuses reads and writes rather than reopening quietly", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);
    await store.close();

    expect(store.isClosed()).toBe(true);
    const read = store.read("SELECT 1");
    const written = store.write((statements) => statements.run("SELECT 1"));

    expect(!read.ok && read.error.code).toBe("closed");
    expect(!written.ok && written.error.code).toBe("closed");
    const copied = store.backupInto(localPath(`${root}/copy.sqlite`));
    expect(!copied.ok && copied.error.code).toBe("closed");
  });

  test("closes once, however many times it is asked", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, ONE_TABLE);

    const [first, second] = await Promise.all([store.close(), store.close()]);
    expect(first).toBe(second);
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
  });
});
