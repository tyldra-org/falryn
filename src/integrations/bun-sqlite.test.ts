import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type LocalPath,
  localPath,
  MAX_SQLITE_DETAIL_LENGTH,
  type SqliteConnectionPort,
  SqliteWorkError,
} from "../domain/index.ts";
import { classifySqliteError, openBunSqlite } from "./bun-sqlite.ts";

const roots: string[] = [];

async function temporaryRoot(): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), "falryn-adapter-"));
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

function openIn(root: LocalPath, name = "adapter.sqlite"): SqliteConnectionPort {
  const opened = openBunSqlite({ path: localPath(`${root}/${name}`), create: true });
  if (!opened.ok) {
    throw new Error(`expected the connection to open: ${opened.error.code}`);
  }
  return opened.value;
}

class DriverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

describe("failure classification", () => {
  test("places a driver code on the declared vocabulary", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["SQLITE_BUSY", "busy"],
      ["SQLITE_BUSY_SNAPSHOT", "busy"],
      ["SQLITE_LOCKED", "busy"],
      ["SQLITE_FULL", "disk-full"],
      ["SQLITE_READONLY_DBMOVED", "read-only"],
      ["SQLITE_CANTOPEN", "cannot-open"],
      ["SQLITE_CORRUPT_VTAB", "corrupt"],
      ["SQLITE_NOTADB", "corrupt"],
      ["SQLITE_CONSTRAINT_NOTNULL", "constraint"],
      ["SQLITE_MISUSE", "closed"],
    ];
    for (const [driverCode, expected] of cases) {
      const classified = classifySqliteError(new DriverError(driverCode, "boom"), "run");
      expect(classified.code).toBe(expected as never);
      expect(classified.driverCode).toBe(driverCode);
    }
  });

  test("keeps an unrecognized driver code rather than guessing a neighbour", () => {
    const classified = classifySqliteError(new DriverError("SQLITE_NOLFS", "unsupported"), "run");

    // Reading `busy` where the driver said something else would send a caller
    // into a retry loop over a database that will never answer.
    expect(classified.code).toBe("io-failure");
    expect(classified.driverCode).toBe("SQLITE_NOLFS");
  });

  test("falls back to the driver's fixed wording when it names no code", () => {
    expect(classifySqliteError(new Error("database is locked"), "run").code).toBe("busy");
    expect(classifySqliteError(new Error("database or disk is full"), "run").code).toBe(
      "disk-full",
    );
    expect(classifySqliteError(new Error("file is not a database"), "open").code).toBe("corrupt");
  });

  test("keeps a classification a transaction already made", () => {
    const inner = classifySqliteError(new DriverError("SQLITE_BUSY", "locked"), "transaction");

    expect(classifySqliteError(new SqliteWorkError(inner), "close")).toEqual(inner);
  });

  test("bounds the driver message it carries", () => {
    const classified = classifySqliteError(new Error("x".repeat(5_000)), "run");

    expect(classified.detail?.length).toBe(MAX_SQLITE_DETAIL_LENGTH);
  });

  test("carries no detail when the driver said nothing", () => {
    expect(classifySqliteError(new Error("   "), "run").detail).toBeNull();
  });
});

describe("opening", () => {
  test("refuses to invent a database when creation is not allowed", async () => {
    const root = await temporaryRoot();
    const opened = openBunSqlite({ path: localPath(`${root}/missing.sqlite`), create: false });

    expect(opened.ok).toBe(false);
    expect(!opened.ok && opened.error.code).toBe("cannot-open");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("statements", () => {
  test("run, read, and report what changed", async () => {
    const connection = openIn(await temporaryRoot());
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT");

    const inserted = connection.run("INSERT INTO t (id, label) VALUES ($id, $label)", {
      id: 7,
      label: "seven",
    });

    expect(inserted.changes).toBe(1);
    expect(inserted.lastInsertRowId).toBe(7);
    expect(connection.all("SELECT label FROM t WHERE id = ?", [7])).toEqual([{ label: "seven" }]);
    await connection.close();
  });

  test("throw a classified failure rather than a bare driver error", async () => {
    const connection = openIn(await temporaryRoot());

    try {
      connection.run("NOT SQL AT ALL");
      throw new Error("expected the statement to be refused");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(SqliteWorkError);
      expect((thrown as SqliteWorkError).failure.operation).toBe("run");
    }
    await connection.close();
  });

  test("refuse a mis-named parameter, because the connection is strict", async () => {
    const connection = openIn(await temporaryRoot());
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");

    expect(() => connection.run("INSERT INTO t (id) VALUES ($id)", { idd: 1 })).toThrow();
    await connection.close();
  });
});

describe("transactions", () => {
  test("commit the work they wrapped", async () => {
    const connection = openIn(await temporaryRoot());
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");

    const outcome = connection.transaction("immediate", () => {
      connection.run("INSERT INTO t (id) VALUES (1)");
      return "done";
    });

    expect(outcome.ok && outcome.value).toBe("done");
    expect(connection.all("SELECT id FROM t")).toEqual([{ id: 1 }]);
    await connection.close();
  });

  test("roll back when the work throws, and report the classified failure", async () => {
    const connection = openIn(await temporaryRoot());
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");

    const outcome = connection.transaction("exclusive", () => {
      connection.run("INSERT INTO t (id) VALUES (1)");
      connection.run("INSERT INTO t (id) VALUES (1)");
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("constraint");
    expect(connection.all("SELECT id FROM t")).toEqual([]);
    await connection.close();
  });

  test("nest through savepoints rather than deadlocking against themselves", async () => {
    const connection = openIn(await temporaryRoot());
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");

    const outcome = connection.transaction("immediate", () => {
      connection.run("INSERT INTO t (id) VALUES (1)");
      const inner = connection.transaction("immediate", () => {
        connection.run("INSERT INTO t (id) VALUES (2)");
        return "inner";
      });
      return inner.ok ? inner.value : "failed";
    });

    expect(outcome.ok && outcome.value).toBe("inner");
    expect(connection.all("SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    await connection.close();
  });
});

describe("backup", () => {
  test("copies the database to a path that did not exist", async () => {
    const root = await temporaryRoot();
    const connection = openIn(root);
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");
    connection.run("INSERT INTO t (id) VALUES (1)");

    const copied = connection.backupInto(localPath(`${root}/copy.sqlite`));
    expect(copied.ok).toBe(true);
    await connection.close();

    const backup = openBunSqlite({ path: localPath(`${root}/copy.sqlite`), create: false });
    expect(backup.ok).toBe(true);
    expect(backup.ok && backup.value.all("SELECT id FROM t")).toEqual([{ id: 1 }]);
    if (backup.ok) {
      await backup.value.close();
    }
  });

  test("refuses to overwrite an existing target", async () => {
    const root = await temporaryRoot();
    const connection = openIn(root);
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");
    const target = localPath(`${root}/copy.sqlite`);

    expect(connection.backupInto(target).ok).toBe(true);
    // Never silently replaced: a leftover backup is evidence of an earlier run,
    // not scratch space.
    expect(connection.backupInto(target).ok).toBe(false);
    await connection.close();
  });
});

describe("the write-ahead log", () => {
  test("leaves one file behind once persistent WAL is disabled and it is truncated", async () => {
    const root = await temporaryRoot();
    const connection = openIn(root);
    expect(connection.pragma("journal_mode = WAL").ok).toBe(true);
    connection.run("CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT");
    connection.run("INSERT INTO t (id) VALUES (1)");

    expect(connection.setPersistentWal(false).ok).toBe(true);
    expect(connection.pragma("wal_checkpoint(TRUNCATE)").ok).toBe(true);
    await connection.close();

    expect(await readdir(root)).toEqual(["adapter.sqlite"]);
  });
});

describe("a closed connection", () => {
  test("refuses further work instead of reopening quietly", async () => {
    const connection = openIn(await temporaryRoot());
    await connection.close();

    expect(connection.pragma("user_version").ok).toBe(false);
    expect(connection.transaction("immediate", () => null).ok).toBe(false);
    expect(() => connection.run("SELECT 1")).toThrow();
  });

  test("closes once, however many times it is asked", async () => {
    const connection = openIn(await temporaryRoot());

    expect((await connection.close()).ok).toBe(true);
    expect((await connection.close()).ok).toBe(true);
  });
});
