/**
 * The SQLite port, the migration contract, and the failures this store reports.
 *
 * The port is SQL-shaped rather than SDK-shaped. It runs a statement, reads
 * rows, applies a pragma, runs synchronous work inside a transaction, copies
 * the database, controls persistent WAL, and closes. No `Database`, no
 * `Statement`, and no driver constant crosses it — a domain that named
 * `SQLITE_FCNTL_PERSIST_WAL` would have taken a dependency on the driver in
 * everything but the import list.
 *
 * Three rules the types carry rather than document:
 *
 * - **A transaction wraps synchronous work.** `bun:sqlite` models better-sqlite3
 *   and hands its transaction a synchronous function, and
 *   [data and state](../../../falryn-docs/architecture/DATA-AND-STATE.md)
 *   requires transactions that never wait on providers, processes, network, or
 *   user input. The signature enforces that structurally: work handed to a
 *   transaction cannot `await`. Wrapping the boundary in a promise would hand
 *   that guarantee back to every caller.
 * - **Close is the one asynchronous operation**, because a truncating WAL
 *   checkpoint waits for readers and a shutdown phase has to be able to give up
 *   on it. Everything else answers immediately or fails.
 * - **A failure is a code plus a bounded driver message**, never a thrown
 *   driver error. The message is developer-facing, is redacted once by the
 *   runtime's single redactor on its way into a cause, and never reaches a user.
 */

import type { ClockPort } from "./clock.ts";
import type { LocalPath } from "./filesystem.ts";
import type { EffectCertainty } from "./outcome.ts";
import type { Result } from "./result.ts";

/** Every value SQLite stores, and nothing else. */
export type SqliteValue = string | number | bigint | boolean | null | Uint8Array;

export type SqliteRow = { readonly [column: string]: SqliteValue };

/** Positional or named bindings. Named bindings are why the driver runs strict. */
export type SqliteBindings = readonly SqliteValue[] | { readonly [name: string]: SqliteValue };

export type SqliteRunOutcome = {
  readonly changes: number;
  readonly lastInsertRowId: number;
};

/**
 * The transaction variants SQLite offers.
 *
 * A write uses `immediate` so a write that will contend fails or waits at
 * `BEGIN` rather than halfway through with an upgrade deadlock. Migration uses
 * `exclusive` so a second process cannot apply the same version concurrently.
 * `deferred` is declared for completeness and is not used by this build.
 */
export const SQLITE_TRANSACTION_KINDS = ["deferred", "immediate", "exclusive"] as const;

export type SqliteTransactionKind = (typeof SQLITE_TRANSACTION_KINDS)[number];

/**
 * What the driver was doing when it failed.
 *
 * Reported so a `busy` from a checkpoint is distinguishable from a `busy` from
 * a write, which are different operational problems.
 */
export const SQLITE_OPERATIONS = [
  "open",
  "pragma",
  "run",
  "read",
  "transaction",
  "backup",
  "file-control",
  "close",
] as const;

export type SqliteOperation = (typeof SQLITE_OPERATIONS)[number];

/**
 * The driver failures this build distinguishes.
 *
 * Everything the adapter cannot place lands on `io-failure` with its driver
 * code preserved, rather than being guessed onto a neighbour. Reading `busy`
 * where the driver said `corrupt` would send a caller into a retry loop over a
 * database that will never answer.
 */
export const SQLITE_FAILURE_CODES = [
  "cannot-open",
  "busy",
  "disk-full",
  "read-only",
  "corrupt",
  "constraint",
  "closed",
  "io-failure",
] as const;

export type SqliteFailureCode = (typeof SQLITE_FAILURE_CODES)[number];

export type SqliteFailure = {
  readonly kind: "sqlite";
  readonly code: SqliteFailureCode;
  readonly operation: SqliteOperation;
  /** The driver's own code, such as `SQLITE_BUSY`, or `null` when it named none. */
  readonly driverCode: string | null;
  /** The driver's message, bounded. Redacted once on its way into a cause. */
  readonly detail: string | null;
};

/** Longest driver message carried out of the adapter. */
export const MAX_SQLITE_DETAIL_LENGTH = 300;

/**
 * A typed failure travelling out of synchronous transaction work.
 *
 * A transaction rolls back when its function throws, so a statement that failed
 * inside one has to throw to roll back — and a bare throw would arrive at the
 * boundary as an unclassifiable foreign error. This carries the classification
 * the adapter already made, so the boundary reports `busy` rather than
 * "something threw".
 */
export class SqliteWorkError extends Error {
  readonly failure: SqliteFailure;

  constructor(failure: SqliteFailure) {
    super(`sqlite ${failure.operation} failed: ${failure.code}`);
    this.name = "SqliteWorkError";
    this.failure = failure;
  }
}

/**
 * Statement access inside a transaction.
 *
 * These throw rather than returning a `Result`, and that is the point: a
 * transaction rolls back when its function throws, so a failure that returned a
 * value would commit the half-applied work the boundary exists to prevent. The
 * throw is caught at the boundary and becomes a typed failure there.
 */
export type SqliteStatements = {
  run(sql: string, bindings?: SqliteBindings): SqliteRunOutcome;
  all(sql: string, bindings?: SqliteBindings): readonly SqliteRow[];
};

export type SqliteConnectionPort = SqliteStatements & {
  /** Applies a pragma and returns whatever it reported, which is often nothing. */
  pragma(statement: string): Result<readonly SqliteRow[], SqliteFailure>;

  /**
   * Runs synchronous work inside one transaction of the requested kind.
   *
   * The work throwing rolls the transaction back and surfaces here as a
   * failure. Nested calls use savepoints, so a caller composing two boundaries
   * does not deadlock against itself.
   */
  transaction<Value>(kind: SqliteTransactionKind, work: () => Value): Result<Value, SqliteFailure>;

  /**
   * Copies the whole database to a path that must not already exist.
   *
   * `VACUUM INTO` rather than a serialize-to-memory copy: serializing
   * materializes the entire database in memory, which is exactly the unbounded
   * behavior a backup taken under disk pressure must not have.
   */
  backupInto(path: LocalPath): Result<null, SqliteFailure>;

  /**
   * Turns persistent WAL on or off.
   *
   * Off is what lets the close sequence leave one file behind on macOS. Named
   * for the behavior rather than for the file-control constant that implements
   * it, so the constant stays inside the adapter.
   */
  setPersistentWal(enabled: boolean): Result<null, SqliteFailure>;

  /**
   * Closes without forcing statements that are still running.
   *
   * Asynchronous alone among these operations, because the truncating
   * checkpoint that precedes it waits on readers and a shutdown phase has to be
   * able to stop waiting.
   */
  close(): Promise<Result<null, SqliteFailure>>;
};

export type SqliteOpenOptions = {
  readonly path: LocalPath;
  /** Whether a missing file may be created. False refuses to invent a database. */
  readonly create: boolean;
};

/** Opens one connection. The only way a connection is ever produced. */
export type SqliteOpener = (
  options: SqliteOpenOptions,
) => Result<SqliteConnectionPort, SqliteFailure>;

/**
 * One forward-only schema step.
 *
 * SQL lives in TypeScript rather than in a `.sql` tree because
 * `bun build --compile` must provably contain it: a file tree needs a loader to
 * be embedded, and a migration missing from the standalone executable would
 * surface as a database that silently looks unmigrated.
 */
export type Migration = {
  /** 1-based and contiguous across the registered set. */
  readonly version: number;
  readonly name: string;
  /** Applied in order inside one transaction. */
  readonly statements: readonly [string, ...string[]];
  /**
   * Whether this step can alter durable user data.
   *
   * A destructive step takes a bounded backup first. A step that only creates
   * tables has nothing to lose and takes none.
   */
  readonly destructive: boolean;
};

/** Registered migrations allowed at once. A set this size is already a defect. */
export const MAX_MIGRATIONS = 1_024;

/** Longest a migration name may be. It is recorded in every database. */
export const MAX_MIGRATION_NAME_LENGTH = 64;

export type MigrationSetErrorCode =
  | "invalid-version"
  | "duplicate-version"
  | "out-of-order"
  | "version-gap"
  | "invalid-name"
  | "empty-statements"
  | "too-many-migrations";

/**
 * A defect in the registered set, found at load.
 *
 * Never echoes SQL. A set is refused before it touches a database, so a
 * defective build cannot half-migrate a user's only copy.
 */
export type MigrationSetError = {
  readonly kind: "migration-set";
  readonly code: MigrationSetErrorCode;
  readonly version: number | null;
  readonly name: string | null;
};

/** One row of the runner's own bookkeeping. */
export type AppliedMigration = {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: number;
};

/**
 * A stable digest of a migration's SQL.
 *
 * FNV-1a, deliberately not cryptographic. It answers one question — has the SQL
 * behind an already-applied version changed since it was applied — and that is
 * a drift check between a build and its own database, not a defence against an
 * adversary who can already write to that database.
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SIXTY_FOUR_BITS = 0xffffffffffffffffn;

/** A byte SQL cannot contain, so two statement lists never collide. */
const STATEMENT_SEPARATOR = String.fromCodePoint(0);

export function migrationChecksum(statements: readonly string[]): string {
  // NUL-joined so `["ab", "c"]` and `["a", "bc"]` are different inputs.
  const bytes = new TextEncoder().encode(statements.join(STATEMENT_SEPARATOR));
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & SIXTY_FOUR_BITS;
  }
  return hash.toString(16).padStart(16, "0");
}

/** The schema version of a database that has had nothing applied to it. */
export const INITIAL_SCHEMA_VERSION = 0;

/** Shortest and longest busy timeout a caller may configure. */
export const MIN_BUSY_TIMEOUT_MS = 100;
export const MAX_BUSY_TIMEOUT_MS = 60_000;

/**
 * How long a contended statement waits before reporting busy.
 *
 * Long enough that an ordinary short transaction in another process finishes
 * first, short enough that a user notices a stuck run rather than a frozen one.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Every way this store fails.
 *
 * `effect` is carried on every member rather than derived from the code,
 * because the same code means different things at different points: a
 * migration that failed inside its own transaction changed nothing, while one
 * interrupted between two migrations changed a known subset.
 */
export type SqliteStoreFailure =
  | {
      /** The database could not be opened, read, or written at all. */
      readonly code: "unavailable";
      readonly operation: SqliteOperation;
      readonly cause: SqliteFailure;
    }
  | {
      /** Another connection held the lock past the busy timeout. */
      readonly code: "busy";
      readonly operation: SqliteOperation;
      readonly cause: SqliteFailure;
    }
  | {
      readonly code: "disk-full";
      readonly operation: SqliteOperation;
      readonly cause: SqliteFailure;
    }
  | {
      /** `PRAGMA integrity_check` reported something other than `ok`. */
      readonly code: "integrity-check-failed";
      /** The first problems the check named, bounded. Nothing is deleted. */
      readonly problems: readonly string[];
    }
  | {
      /** The file records a version this build has no migration for. */
      readonly code: "schema-too-new";
      readonly recordedVersion: number;
      readonly applicationVersion: number;
    }
  | {
      /** The SQL behind an applied version is not the SQL this build declares. */
      readonly code: "checksum-mismatch";
      readonly version: number;
      readonly recordedChecksum: string;
      readonly declaredChecksum: string;
    }
  | {
      /** The registered set is defective. Refused before it touched anything. */
      readonly code: "invalid-migration-set";
      readonly issues: readonly MigrationSetError[];
    }
  | {
      /** One migration failed and rolled back. Its version stays unrecorded. */
      readonly code: "migration-failed";
      readonly version: number;
      readonly name: string;
      readonly recordedVersion: number;
      readonly appliedVersions: readonly number[];
      readonly backupPath: LocalPath | null;
      readonly cause: SqliteFailure;
    }
  | {
      /**
       * Migration stopped between steps.
       *
       * Diagnosable rather than repaired: it names what was recorded, what it
       * applied, and where the backup is. Nothing is deleted, because the
       * database it would delete may be the only usable copy.
       */
      readonly code: "migration-interrupted";
      readonly recordedVersion: number;
      readonly appliedVersions: readonly number[];
      readonly backupPath: LocalPath | null;
    }
  | {
      /**
       * SQLite refused the statement itself.
       *
       * A constraint violation or malformed SQL is a defect in the caller,
       * not a condition of the database, and rolling it in with `unavailable`
       * would send someone looking at their disk.
       */
      readonly code: "statement-rejected";
      readonly operation: SqliteOperation;
      readonly cause: SqliteFailure;
    }
  | {
      /** Cancelled before anything began. Nothing committed. */
      readonly code: "cancelled";
      readonly operation: SqliteOperation;
    }
  | {
      /** Used after the close sequence ran. */
      readonly code: "closed";
      readonly operation: SqliteOperation;
    };

/**
 * A store failure with its effect certainty attached.
 *
 * `kind` and `effect` are kept off the union members so a builder can supply
 * one member's fields plus the effect without every member growing two more
 * lines that say the same thing.
 */
export type SqliteStoreError = SqliteStoreFailure & {
  readonly kind: "sqlite-store";
  readonly effect: EffectCertainty;
};

/** Problems from an integrity check carried into an error before it is bounded. */
export const MAX_INTEGRITY_PROBLEMS = 8;

/** What the close sequence did, step by step. */
export type SqliteCloseReport = {
  /** Whether persistent WAL was disabled, which is what lets the sidecars go. */
  readonly persistentWalDisabled: boolean;
  readonly checkpointed: boolean;
  readonly closed: boolean;
  /** Every step that failed, in order. A later failure never hides an earlier one. */
  readonly failures: readonly SqliteFailure[];
};

export function isCleanClose(report: SqliteCloseReport): boolean {
  return (
    report.persistentWalDisabled &&
    report.checkpointed &&
    report.closed &&
    report.failures.length === 0
  );
}

/**
 * What a write did.
 *
 * `cancelledAfterCommit` exists because the two facts are independent:
 * cancellation that arrives after `COMMIT` did not undo the commit, and
 * reporting it as `cancelled` would tell a caller nothing happened when
 * something did. Cancellation before `BEGIN` is the error member instead, which
 * keeps `cancelled` meaning exactly "did not commit".
 */
export type SqliteWriteOutcome<Value> = {
  readonly value: Value;
  readonly cancelledAfterCommit: boolean;
};

/** What opening produced, before any product code has read a row. */
export type SqliteOpenReport = {
  readonly path: LocalPath;
  readonly created: boolean;
  readonly schemaVersion: number;
  readonly applied: readonly AppliedMigration[];
  /** Versions this run applied, as opposed to ones it found already recorded. */
  readonly appliedThisRun: readonly number[];
  readonly backupPath: LocalPath | null;
};

export type SqliteStorePort = {
  readonly report: SqliteOpenReport;

  /** Reads rows outside a transaction. */
  read(sql: string, bindings?: SqliteBindings): Result<readonly SqliteRow[], SqliteStoreError>;

  /**
   * Runs synchronous work inside one immediate transaction.
   *
   * `immediate` rather than deferred so a write that will contend fails or
   * waits at `BEGIN`, rather than halfway through with an upgrade deadlock.
   */
  write<Value>(
    work: (statements: SqliteStatements) => Value,
    signal?: AbortSignal,
  ): Result<SqliteWriteOutcome<Value>, SqliteStoreError>;

  /** Runs the close sequence. Idempotent; a second call reports the first result. */
  close(signal?: AbortSignal): Promise<SqliteCloseReport>;

  isClosed(): boolean;
};

export type SqliteStoreOptions = {
  readonly open: SqliteOpener;
  readonly clock: ClockPort;
  readonly databasePath: LocalPath;
  /** Where a pre-migration backup is written. Inside the `state` root. */
  readonly backupDirectory: LocalPath;
  readonly migrations: readonly Migration[];
  readonly busyTimeoutMs?: number;
  /** Whether a missing database may be created. */
  readonly create?: boolean;
};
