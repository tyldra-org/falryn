/**
 * Shared fixtures for the data area's tests.
 *
 * Test-only. Not re-exported from `index.ts` and not imported by product code.
 *
 * Two things live here because more than one test file needs them and a second
 * copy of either would drift: a temporary state root with its cleanup, and the
 * fault decorator that stages conditions a temporary directory cannot produce.
 * The decorator wraps the real `bun:sqlite` connection and fails exactly one
 * operation, so everything it does not intercept is the genuine driver and a
 * test still proves the store's behavior rather than a mock's.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createManualClock,
  err,
  instant,
  type LocalPath,
  localPath,
  type Migration,
  ok,
  type Result,
  type SqliteConnectionPort,
  type SqliteFailure,
  type SqliteFailureCode,
  type SqliteOpener,
  type SqliteOperation,
  type SqliteRow,
  type SqliteStoreError,
  type SqliteStorePort,
  SqliteWorkError,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import { PRODUCTION_MIGRATIONS } from "./sqlite-migrations.ts";
import { openSqliteStore, sqliteDatabasePath } from "./sqlite-store.ts";

/** A fixed instant, so a stored timestamp is stable across runs and machines. */
export const FIXTURE_INSTANT = instant(Date.UTC(2026, 6, 31, 12, 0, 0));

export type Faults = {
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

export function faultingOpener(faults: Faults): SqliteOpener {
  return (options) => {
    const opened = openBunSqlite(options);
    if (!opened.ok) {
      return opened;
    }
    return ok(decorateConnection(opened.value, faults));
  };
}

export function decorateConnection(
  inner: SqliteConnectionPort,
  faults: Faults,
): SqliteConnectionPort {
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

const roots: string[] = [];

/** A private temporary directory, removed by {@link removeTemporaryRoots}. */
export async function temporaryRoot(prefix: string): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  roots.push(created);
  return localPath(created);
}

export async function removeTemporaryRoots(): Promise<void> {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export type OpenOptions = {
  readonly faults?: Faults;
  readonly migrations?: readonly Migration[];
};

/** Opens the production schema against a temporary root. */
export function openProductStore(
  root: LocalPath,
  options: OpenOptions = {},
): Promise<Result<SqliteStorePort, SqliteStoreError>> {
  const path = sqliteDatabasePath(root);
  if (path === null) {
    throw new Error("the temporary root did not produce a database path");
  }
  return openSqliteStore({
    open: options.faults === undefined ? openBunSqlite : faultingOpener(options.faults),
    clock: createManualClock(FIXTURE_INSTANT),
    databasePath: path,
    backupDirectory: root,
    migrations: options.migrations ?? PRODUCTION_MIGRATIONS,
  });
}

export async function openProductStoreOrThrow(
  root: LocalPath,
  options: OpenOptions = {},
): Promise<SqliteStorePort> {
  const opened = await openProductStore(root, options);
  if (!opened.ok) {
    throw new Error(`expected the store to open: ${opened.error.code}`);
  }
  return opened.value;
}
