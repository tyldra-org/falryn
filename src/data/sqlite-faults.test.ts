/**
 * Store behavior under conditions a temporary directory cannot produce.
 *
 * A full disk, a failing checkpoint, and a corrupt index are real failures with
 * no reliable way to stage them, so they are staged at the port instead: a
 * decorator over the real `bun:sqlite` connection that fails exactly one
 * operation. Everything the decorator does not intercept is the genuine driver,
 * so a test here still proves the store's behavior rather than a mock's.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShutdownCoordinator } from "../application/index.ts";
import {
  createManualClock,
  err,
  instant,
  type LocalPath,
  localPath,
  type ManualClock,
  type Migration,
  ok,
  type ShutdownReport,
  type SqliteConnectionPort,
  type SqliteFailure,
  type SqliteFailureCode,
  type SqliteOpener,
  type SqliteOperation,
  type SqliteRow,
  type SqliteStorePort,
  SqliteWorkError,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import {
  createSqliteShutdownParticipant,
  openSqliteStore,
  sqliteDatabasePath,
} from "./sqlite-store.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), "falryn-sqlite-fault-"));
  roots.push(created);
  return localPath(created);
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

type Faults = {
  /** Operations to fail, with the driver code to fail them as. */
  readonly failOperations?: Partial<Record<SqliteOperation, SqliteFailureCode>>;
  /** Rows `PRAGMA integrity_check` should answer with instead of `ok`. */
  readonly integrityProblems?: readonly string[];
  /** Whether `close` never resolves, as a connection with a stuck reader would. */
  readonly closeHangs?: boolean;
};

function failure(code: SqliteFailureCode, operation: SqliteOperation): SqliteFailure {
  return {
    kind: "sqlite",
    code,
    operation,
    driverCode: `SQLITE_${code.toUpperCase().replaceAll("-", "_")}`,
    detail: `injected ${code} on ${operation}`,
  };
}

function faultingOpener(faults: Faults): SqliteOpener {
  return (options) => {
    const opened = openBunSqlite(options);
    if (!opened.ok) {
      return opened;
    }
    return ok(decorate(opened.value, faults));
  };
}

function decorate(inner: SqliteConnectionPort, faults: Faults): SqliteConnectionPort {
  const failFor = (operation: SqliteOperation): SqliteFailure | null => {
    const code = faults.failOperations?.[operation];
    return code === undefined ? null : failure(code, operation);
  };

  return {
    run(sql, bindings) {
      const injected = failFor("run");
      if (injected !== null) {
        throw new SqliteWorkError(injected);
      }
      return inner.run(sql, bindings);
    },
    all(sql, bindings) {
      return inner.all(sql, bindings);
    },
    pragma(statement) {
      const injected = failFor("pragma");
      if (injected !== null) {
        return err(injected);
      }
      if (statement === "integrity_check" && faults.integrityProblems !== undefined) {
        const rows: SqliteRow[] = faults.integrityProblems.map((problem) => ({
          integrity_check: problem,
        }));
        return ok(rows);
      }
      return inner.pragma(statement);
    },
    transaction(kind, work) {
      const injected = failFor("transaction");
      if (injected !== null) {
        return err(injected);
      }
      return inner.transaction(kind, work);
    },
    backupInto(path) {
      const injected = failFor("backup");
      return injected === null ? inner.backupInto(path) : err(injected);
    },
    setPersistentWal(enabled) {
      const injected = failFor("file-control");
      return injected === null ? inner.setPersistentWal(enabled) : err(injected);
    },
    async close() {
      if (faults.closeHangs === true) {
        // A connection whose truncating checkpoint is waiting on a reader that
        // never finishes. The phase deadline has to be what ends this.
        return new Promise(() => {});
      }
      const injected = failFor("close");
      if (injected !== null) {
        await inner.close();
        return err(injected);
      }
      return inner.close();
    },
  };
}

function createTable(version: number, table: string): Migration {
  return {
    version,
    name: `create-${table}`,
    statements: [`CREATE TABLE ${table} (id INTEGER PRIMARY KEY) STRICT`],
    destructive: false,
  };
}

const ONE_TABLE: readonly Migration[] = [createTable(1, "alpha")];

function open(root: LocalPath, faults: Faults, migrations: readonly Migration[] = ONE_TABLE) {
  const path = sqliteDatabasePath(root);
  if (path === null) {
    throw new Error("the temporary root did not produce a database path");
  }
  return openSqliteStore({
    open: faultingOpener(faults),
    clock: createManualClock(instant(1_700_000_000_000)),
    databasePath: path,
    backupDirectory: root,
    migrations,
  });
}

async function openOrThrow(
  root: LocalPath,
  faults: Faults,
  migrations: readonly Migration[] = ONE_TABLE,
): Promise<SqliteStorePort> {
  const opened = await open(root, faults, migrations);
  if (!opened.ok) {
    throw new Error(`expected the store to open: ${opened.error.code}`);
  }
  return opened.value;
}

describe("a failed integrity check", () => {
  test("refuses the database, names the problems, and deletes nothing", async () => {
    const root = await temporaryRoot();
    const opened = await open(root, {
      integrityProblems: ["row 4 missing from index alpha_label", "wrong # of entries in index"],
    });

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toMatchObject({
      code: "integrity-check-failed",
      problems: ["row 4 missing from index alpha_label", "wrong # of entries in index"],
      effect: "none",
    });
    // The file it refused is still the file it found.
    expect(await readdir(root)).toEqual(["falryn.sqlite"]);
  });

  test("accepts the database when the check answers ok", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, { integrityProblems: ["ok"] });

    expect(store.report.schemaVersion).toBe(1);
    await store.close();
  });
});

describe("a full disk", () => {
  test("is reported as disk-full from a write rather than as a broken database", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, {});
    const full = await openOrThrow(root, { failOperations: { transaction: "disk-full" } });

    const written = full.write((statements) => statements.run("INSERT INTO alpha (id) VALUES (1)"));

    expect(written.ok).toBe(false);
    expect(!written.ok && written.error).toMatchObject({
      code: "disk-full",
      operation: "transaction",
      effect: "none",
    });

    await full.close();
    await store.close();
  });

  test("is reported from the pre-migration backup rather than half-migrating", async () => {
    const root = await temporaryRoot();
    await (await openOrThrow(root, {})).close();

    const destructive: readonly Migration[] = [
      createTable(1, "alpha"),
      { version: 2, name: "drop-alpha", statements: ["DROP TABLE alpha"], destructive: true },
    ];
    const opened = await open(root, { failOperations: { backup: "disk-full" } }, destructive);

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error).toMatchObject({
      code: "disk-full",
      operation: "backup",
    });
    // The migration never ran, so the table the backup was protecting is intact.
    const reopened = await openOrThrow(root, {}, [destructive[0] as Migration]);
    expect(reopened.report.schemaVersion).toBe(1);
    await reopened.close();
  });
});

describe("an unobserved commit", () => {
  test("reports an uncertain effect rather than claiming nothing happened", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, {});
    const flaky = await openOrThrow(root, { failOperations: { transaction: "io-failure" } });

    const written = flaky.write((statements) =>
      statements.run("INSERT INTO alpha (id) VALUES (1)"),
    );

    // An I/O failure at COMMIT did not report whether it reached the disk.
    // Saying `none` would authorize a retry that could duplicate the row.
    expect(!written.ok && written.error).toMatchObject({
      code: "unavailable",
      effect: "uncertain",
    });

    await flaky.close();
    await store.close();
  });
});

describe("the close sequence", () => {
  test("attempts every step and keeps every failure", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, {
      failOperations: { "file-control": "io-failure", close: "io-failure" },
    });

    const report = await store.close();

    expect(report.persistentWalDisabled).toBe(false);
    // The checkpoint still ran: a step failing is exactly when the later ones
    // matter most.
    expect(report.checkpointed).toBe(true);
    expect(report.closed).toBe(false);
    expect(report.failures.map((entry) => entry.operation)).toEqual(["file-control", "close"]);
  });
});

async function runShutdown(
  clock: ManualClock,
  participant: ReturnType<typeof createSqliteShutdownParticipant>,
): Promise<ShutdownReport> {
  const coordinator = createShutdownCoordinator({ clock });
  coordinator.register(participant);
  const pending = coordinator.shutdown();
  await clock.runUntilIdle();
  return pending;
}

describe("the close-storage participant", () => {
  test("completes a clean shutdown when the close sequence succeeds", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, {});
    const clock = createManualClock(instant(0));

    const report = await runShutdown(clock, createSqliteShutdownParticipant(store));

    expect(report.outcome).toEqual({ kind: "completed" });
    expect(report.unfinished).toEqual([]);
    expect(store.isClosed()).toBe(true);
  });

  test("records a failure when the close sequence did not complete", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, { failOperations: { close: "io-failure" } });
    const clock = createManualClock(instant(0));

    const report = await runShutdown(clock, createSqliteShutdownParticipant(store));

    expect(report.failures.map((entry) => entry.name)).toEqual(["sqlite-store"]);
    expect(report.outcome.kind).not.toBe("completed");
  });

  test("leaves the shutdown uncertain when a statement outlives the phase", async () => {
    const root = await temporaryRoot();
    const store = await openOrThrow(root, { closeHangs: true });
    const clock = createManualClock(instant(0));

    const report = await runShutdown(clock, createSqliteShutdownParticipant(store));

    // The coordinator's existing contract: what was not observed stopping is
    // reported as uncertain rather than as a clean exit.
    expect(report.unfinished).toEqual(["sqlite-store"]);
    expect(report.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
  });
});
