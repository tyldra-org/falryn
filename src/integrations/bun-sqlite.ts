/**
 * The `bun:sqlite` adapter.
 *
 * The only module in the tree that constructs a `Database`. Everything above it
 * speaks `SqliteConnectionPort`, which is SQL-shaped: no driver handle, no
 * prepared statement, and no driver constant leaves this file. That is what
 * lets the migration runner, the transaction boundary, and the close sequence
 * be tested against a substitute connection while this file stays a leaf.
 *
 * The connection opens in **strict mode**. Strict turns a mis-named bound
 * parameter into an error instead of binding `null`, which is the difference
 * between a failing test and a row that silently stored nothing.
 *
 * A driver error is classified here and nowhere else. An error this table does
 * not recognize becomes `io-failure` with its driver code preserved, rather
 * than being guessed onto a neighbouring code — reading `busy` where the driver
 * said `corrupt` would send a caller into a retry loop over a database that
 * will never answer.
 *
 * The file this adapter creates is owner-only, like the artifact blobs and the
 * export packages the sibling adapters write. It is created before SQLite opens
 * it rather than adjusted afterwards, so there is no window in which sessions,
 * turns, invocations, and events are readable by anyone else — and because
 * SQLite derives the `-wal` and `-shm` permissions from the database's own, the
 * mode has to be in place before the journal mode is switched.
 */

import { constants, Database } from "bun:sqlite";
import { chmodSync, closeSync, openSync } from "node:fs";

import {
  err,
  type LocalPath,
  MAX_SQLITE_DETAIL_LENGTH,
  ok,
  type Result,
  type SqliteBindings,
  type SqliteConnectionPort,
  type SqliteFailure,
  type SqliteFailureCode,
  type SqliteOpenOptions,
  type SqliteOperation,
  type SqliteRow,
  type SqliteRunOutcome,
  type SqliteTransactionKind,
  type SqliteValue,
  SqliteWorkError,
} from "../domain/index.ts";

/**
 * The mode a database, its backup, an artifact blob, and an export package all
 * get. Spelled the same way in `host-blobs.ts` and `host-packages.ts`, because
 * three adapters stating the same decision identically is what makes a fourth
 * one's absence visible.
 */
const PRIVATE_FILE_MODE = 0o600;

/** Driver code prefixes, longest first so `SQLITE_READONLY_DBMOVED` is not read as `SQLITE_READ`. */
const DRIVER_CODE_PREFIXES: readonly (readonly [string, SqliteFailureCode])[] = [
  ["SQLITE_BUSY", "busy"],
  ["SQLITE_LOCKED", "busy"],
  ["SQLITE_FULL", "disk-full"],
  ["SQLITE_READONLY", "read-only"],
  ["SQLITE_CANTOPEN", "cannot-open"],
  ["SQLITE_CORRUPT", "corrupt"],
  ["SQLITE_NOTADB", "corrupt"],
  ["SQLITE_CONSTRAINT", "constraint"],
  ["SQLITE_MISUSE", "closed"],
];

/**
 * Messages the driver produces without a code.
 *
 * The `Database` constructor and a few file-level failures throw a plain
 * `Error`, so the message is the only signal there is. Matched on the driver's
 * own fixed wording rather than on anything a user supplied.
 */
const MESSAGE_PATTERNS: readonly (readonly [string, SqliteFailureCode])[] = [
  ["database is locked", "busy"],
  ["database table is locked", "busy"],
  ["database or disk is full", "disk-full"],
  ["attempt to write a readonly database", "read-only"],
  ["unable to open database", "cannot-open"],
  ["out of memory", "io-failure"],
  ["file is not a database", "corrupt"],
  ["database disk image is malformed", "corrupt"],
];

function boundedDetail(message: string): string | null {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > MAX_SQLITE_DETAIL_LENGTH
    ? trimmed.slice(0, MAX_SQLITE_DETAIL_LENGTH)
    : trimmed;
}

function driverCodeOf(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null) {
    return null;
  }
  const code = (thrown as { readonly code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * Places a thrown driver value on the declared failure vocabulary.
 *
 * Exported because it is the whole of the adapter's judgement, and the
 * conditions it judges — a full disk, a corrupt file — are ones a test cannot
 * reliably produce for real.
 */
export function classifySqliteError(thrown: unknown, operation: SqliteOperation): SqliteFailure {
  // A failure that was already classified deeper in a transaction keeps its
  // classification rather than being re-derived from a wrapper message.
  if (thrown instanceof SqliteWorkError) {
    return thrown.failure;
  }

  const driverCode = driverCodeOf(thrown);
  const message = thrown instanceof Error ? thrown.message : String(thrown);

  if (driverCode !== null) {
    for (const [prefix, code] of DRIVER_CODE_PREFIXES) {
      if (driverCode.startsWith(prefix)) {
        return { kind: "sqlite", code, operation, driverCode, detail: boundedDetail(message) };
      }
    }
  }

  const lowered = message.toLowerCase();
  for (const [pattern, code] of MESSAGE_PATTERNS) {
    if (lowered.includes(pattern)) {
      return { kind: "sqlite", code, operation, driverCode, detail: boundedDetail(message) };
    }
  }

  return {
    kind: "sqlite",
    code: "io-failure",
    operation,
    driverCode,
    detail: boundedDetail(message),
  };
}

/**
 * Escapes a path into a single-quoted SQL literal.
 *
 * `VACUUM INTO` is a top-level statement, and binding its target is not
 * portable across the versions of SQLite this build may be compiled against.
 * The path is a validated `LocalPath` — absolute, NUL-free, and produced by
 * Falryn rather than by a user — so the one escape that remains is the quote.
 */
function quotePath(path: LocalPath): string {
  return `'${path.replaceAll("'", "''")}'`;
}

type BunStatementResult = { readonly lastInsertRowid: number | bigint; readonly changes: number };

function runOutcomeOf(result: BunStatementResult): SqliteRunOutcome {
  return {
    changes: Number(result.changes),
    lastInsertRowId: Number(result.lastInsertRowid),
  };
}

/**
 * Creates the database file owner-only, before SQLite ever sees the path.
 *
 * `wx` is create-exclusive: an existing database is never touched, which is the
 * diagnose-rather-than-adjust rule applied to a file. The mode is then set
 * explicitly so an unusual umask can neither widen nor narrow what was asked
 * for.
 *
 * Nothing here reports a failure. `EEXIST` is the ordinary case, and any other
 * errno describes a path the `Database` constructor is about to fail on a
 * moment later — where the one classification table this adapter owns already
 * names it. A second vocabulary here would give the same cause two spellings.
 */
function precreatePrivateDatabase(path: LocalPath): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", PRIVATE_FILE_MODE);
  } catch {
    return;
  }
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch {
    // Left to the open below, for the same reason.
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Opens the one connection.
 *
 * `readwrite` is explicit rather than inherited from the default, so a future
 * read-only path has to say so instead of arriving by omission.
 */
export function openBunSqlite(
  options: SqliteOpenOptions,
): Result<SqliteConnectionPort, SqliteFailure> {
  if (options.create) {
    // Only when creation is permitted: `create: false` must not invent a file.
    precreatePrivateDatabase(options.path);
  }

  let database: Database;
  try {
    database = new Database(options.path, {
      create: options.create,
      readwrite: true,
      strict: true,
    });
  } catch (thrown) {
    return err(classifySqliteError(thrown, "open"));
  }

  let closed = false;

  const closedFailure = (operation: SqliteOperation): SqliteFailure => ({
    kind: "sqlite",
    code: "closed",
    operation,
    driverCode: null,
    detail: "the connection is closed",
  });

  const rowsOf = (sql: string, bindings: SqliteBindings | undefined): readonly SqliteRow[] => {
    const statement = database.query<SqliteRow, SqliteValue[]>(sql);
    if (bindings === undefined) {
      return statement.all();
    }
    return Array.isArray(bindings)
      ? statement.all(...(bindings as SqliteValue[]))
      : statement.all(bindings as never);
  };

  const connection: SqliteConnectionPort = {
    run(sql: string, bindings?: SqliteBindings): SqliteRunOutcome {
      if (closed) {
        throw new SqliteWorkError(closedFailure("run"));
      }
      try {
        const result =
          bindings === undefined
            ? database.run(sql)
            : Array.isArray(bindings)
              ? database.run(sql, bindings as SqliteValue[])
              : database.run(sql, bindings as never);
        return runOutcomeOf(result as BunStatementResult);
      } catch (thrown) {
        throw new SqliteWorkError(classifySqliteError(thrown, "run"));
      }
    },

    all(sql: string, bindings?: SqliteBindings): readonly SqliteRow[] {
      if (closed) {
        throw new SqliteWorkError(closedFailure("read"));
      }
      try {
        return rowsOf(sql, bindings);
      } catch (thrown) {
        throw new SqliteWorkError(classifySqliteError(thrown, "read"));
      }
    },

    pragma(statement: string): Result<readonly SqliteRow[], SqliteFailure> {
      if (closed) {
        return err(closedFailure("pragma"));
      }
      try {
        // Read through a query rather than `run`, because several of the
        // pragmas this build applies — `journal_mode`, `integrity_check`,
        // `wal_checkpoint` — answer with the rows that prove they took effect.
        return ok(rowsOf(`PRAGMA ${statement}`, undefined));
      } catch (thrown) {
        return err(classifySqliteError(thrown, "pragma"));
      }
    },

    transaction<Value>(
      kind: SqliteTransactionKind,
      work: () => Value,
    ): Result<Value, SqliteFailure> {
      if (closed) {
        return err(closedFailure("transaction"));
      }
      try {
        const cell: {
          outcome: { readonly kind: "pending" } | { readonly kind: "done"; readonly value: Value };
        } = {
          outcome: { kind: "pending" },
        };
        const wrapped = database.transaction(() => {
          cell.outcome = { kind: "done", value: work() };
        });
        wrapped[kind]();
        const outcome = cell.outcome;
        if (outcome.kind === "pending") {
          throw new Error("SQLite transaction completed without running its work");
        }
        return ok(outcome.value);
      } catch (thrown) {
        return err(classifySqliteError(thrown, "transaction"));
      }
    },

    backupInto(path: LocalPath): Result<null, SqliteFailure> {
      if (closed) {
        return err(closedFailure("backup"));
      }
      try {
        database.run(`VACUUM INTO ${quotePath(path)}`);
        // `VACUUM INTO` refuses an existing target, so this file is always new
        // and the mode is never an adjustment. A failure here fails the backup:
        // the store's next act is a destructive migration against a database
        // whose only copy would otherwise be world-readable.
        chmodSync(path, PRIVATE_FILE_MODE);
        return ok(null);
      } catch (thrown) {
        return err(classifySqliteError(thrown, "backup"));
      }
    },

    setPersistentWal(enabled: boolean): Result<null, SqliteFailure> {
      if (closed) {
        return err(closedFailure("file-control"));
      }
      try {
        database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, enabled ? 1 : 0);
        return ok(null);
      } catch (thrown) {
        return err(classifySqliteError(thrown, "file-control"));
      }
    },

    async close(): Promise<Result<null, SqliteFailure>> {
      if (closed) {
        return ok(null);
      }
      try {
        // No argument: closing must not throw over statements that are still
        // running. A statement that outlives its phase is reported as an
        // unfinished shutdown participant, which is a truer fact than a
        // close that claimed success by force.
        database.close();
        closed = true;
        return ok(null);
      } catch (thrown) {
        return err(classifySqliteError(thrown, "close"));
      }
    },
  };

  return ok(connection);
}
