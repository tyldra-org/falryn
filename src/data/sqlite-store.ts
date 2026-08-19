/**
 * Falryn's one database: where it lives, how it opens, how its schema moves
 * forward, what a transaction means, and how it closes.
 *
 * One connection, one pragma set, one migration runner, one transaction
 * boundary, and one close path are the same lifecycle seen from five angles.
 * Split apart they produce a database nobody may write to, or migrations with
 * no transaction, so they live together and are reached through one surface.
 *
 * Four rules the implementation carries rather than documents:
 *
 * - **Pragmas are applied in exactly one place.** Independently written
 *   features that each chose their own durability settings would produce
 *   conflicting guarantees no test would catch.
 * - **A migration is applied inside an exclusive transaction, once.** The
 *   recorded version is re-read inside that transaction, so a second Falryn
 *   process racing the first waits its busy timeout and then finds the work
 *   already done rather than repeating it.
 * - **Nothing is repaired.** A checksum mismatch, a database recorded newer
 *   than this build, a failed integrity check, and an interrupted migration are
 *   each refused with the facts needed to diagnose them. None of them deletes
 *   anything, because what would be deleted may be the only usable copy.
 * - **Close is a sequence.** Persistent WAL off, truncating checkpoint, then a
 *   close that does not force statements that are still running — so retention
 *   measurement, reset, and uninstall see one file, and a leftover `-wal` is a
 *   real signal of a crashed run rather than normal debris.
 *
 * SQL lives here and in the migration list beside it. It does not live in the
 * adapter, which speaks statements it is handed, and it does not live anywhere
 * further out.
 */

import {
  type AppliedMigration,
  DEFAULT_BUSY_TIMEOUT_MS,
  type EffectCertainty,
  err,
  INITIAL_SCHEMA_VERSION,
  isCleanClose,
  joinPath,
  type LocalPath,
  MAX_BUSY_TIMEOUT_MS,
  MAX_INTEGRITY_PROBLEMS,
  MIN_BUSY_TIMEOUT_MS,
  type Migration,
  migrationChecksum,
  type OwnershipRegistration,
  ok,
  type Result,
  type ShutdownParticipant,
  type SqliteBindings,
  type SqliteCloseReport,
  type SqliteConnectionPort,
  type SqliteFailure,
  type SqliteOpenReport,
  type SqliteOperation,
  type SqliteRow,
  type SqliteStatements,
  type SqliteStoreError,
  type SqliteStoreFailure,
  type SqliteStoreOptions,
  type SqliteStorePort,
  type SqliteValue,
  SqliteWorkError,
  type SqliteWriteOutcome,
} from "../domain/index.ts";
import { latestVersion, validateMigrationSet } from "./sqlite-migrations.ts";

/** The database file name, inside the resolved `state` root. */
export const SQLITE_DATABASE_FILE = "falryn.sqlite";

/**
 * The runner's own bookkeeping table.
 *
 * Created outside the migration list, because it has to exist before that
 * list's state can be known. Prefixed so it never collides with a product table
 * a later migration introduces.
 */
export const MIGRATION_TABLE = "falryn_schema_migrations";

/** The shutdown participant's name, reported when it does not finish. */
export const SQLITE_PARTICIPANT_NAME = "sqlite-store";

/**
 * Durable application state, registered by the owner that writes it.
 *
 * `export-before-reset`, because these rows are a user's working history and a
 * reset that dropped them without an export offered would destroy the only copy
 * of something nobody chose to lose. It deliberately gets no `data.retention`
 * entry: retention classes are the rotating and rebuildable ones, and durable
 * state is measured for usage and counted against the total quota rather than
 * aged out.
 */
export const SQLITE_STATE_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "sqliteState",
  owner: "sqlite-store",
  durability: "app-owned",
  removalPosture: "export-before-reset",
  roots: ["state"],
  external: false,
};

const CREATE_MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT`;

const SELECT_APPLIED = `SELECT version, name, checksum, applied_at AS appliedAt
  FROM ${MIGRATION_TABLE} ORDER BY version`;

const SELECT_RECORDED_VERSION = `SELECT COALESCE(MAX(version), 0) AS recordedVersion
  FROM ${MIGRATION_TABLE}`;

const INSERT_APPLIED = `INSERT INTO ${MIGRATION_TABLE}
  (version, name, checksum, applied_at)
  VALUES ($version, $name, $checksum, $appliedAt)`;

function storeError(
  failure: SqliteStoreFailure & { readonly effect: EffectCertainty },
): SqliteStoreError {
  return { kind: "sqlite-store", ...failure };
}

/**
 * Whether cancellation has been requested right now.
 *
 * A free function rather than an inline check, because narrowing an
 * `AbortSignal` once would make every later read of the same signal look
 * settled to the type checker — and the whole point of checking again after a
 * commit is that the answer may have changed.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Places a driver failure on the store's vocabulary.
 *
 * `io-failure` is the only one that carries `uncertain`: a `COMMIT` that failed
 * on I/O did not report whether it reached the disk, and claiming the effect
 * was `none` would authorize a retry that could duplicate it. Everything else
 * either never began or rolled back.
 */
export function storeErrorForFailure(
  failure: SqliteFailure,
  operation: SqliteOperation,
): SqliteStoreError {
  switch (failure.code) {
    case "busy":
      return storeError({ code: "busy", operation, cause: failure, effect: "none" });
    case "disk-full":
      return storeError({ code: "disk-full", operation, cause: failure, effect: "none" });
    case "constraint":
      return storeError({
        code: "statement-rejected",
        operation,
        cause: failure,
        effect: "none",
      });
    case "closed":
      return storeError({ code: "closed", operation, effect: "none" });
    case "io-failure":
      return storeError({ code: "unavailable", operation, cause: failure, effect: "uncertain" });
    case "cannot-open":
    case "read-only":
    case "corrupt":
      return storeError({ code: "unavailable", operation, cause: failure, effect: "none" });
  }
}

/** Recovers the classification a statement threw inside a transaction. */
function failureOfThrown(thrown: unknown, operation: SqliteOperation): SqliteFailure {
  if (thrown instanceof SqliteWorkError) {
    return thrown.failure;
  }
  return {
    kind: "sqlite",
    code: "io-failure",
    operation,
    driverCode: null,
    detail: thrown instanceof Error ? thrown.message : null,
  };
}

function integerOf(value: SqliteValue | undefined): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

function textOf(value: SqliteValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function appliedFromRow(row: SqliteRow): AppliedMigration {
  return {
    version: integerOf(row.version),
    name: textOf(row.name),
    checksum: textOf(row.checksum),
    appliedAt: integerOf(row.appliedAt),
  };
}

/**
 * Runs the close sequence, whatever went before it.
 *
 * Every step is attempted even when an earlier one failed, and every failure is
 * kept: a checkpoint that could not run is exactly the case where the close
 * still has to happen, and hiding the first failure behind the second would
 * lose the reason the sidecars are still there.
 */
async function runCloseSequence(connection: SqliteConnectionPort): Promise<SqliteCloseReport> {
  const failures: SqliteFailure[] = [];

  const persistentWal = connection.setPersistentWal(false);
  if (!persistentWal.ok) {
    failures.push(persistentWal.error);
  }

  const checkpoint = connection.pragma("wal_checkpoint(TRUNCATE)");
  if (!checkpoint.ok) {
    failures.push(checkpoint.error);
  }

  const closed = await connection.close();
  if (!closed.ok) {
    failures.push(closed.error);
  }

  return {
    persistentWalDisabled: persistentWal.ok,
    checkpointed: checkpoint.ok,
    closed: closed.ok,
    failures,
  };
}

/** The database's path inside a resolved `state` root. */
export function sqliteDatabasePath(stateRoot: LocalPath): LocalPath | null {
  const joined = joinPath(stateRoot, SQLITE_DATABASE_FILE);
  return joined.ok ? joined.value : null;
}

function backupPathFor(directory: LocalPath, version: number): LocalPath | null {
  const joined = joinPath(directory, `falryn-backup-v${version}.sqlite`);
  return joined.ok ? joined.value : null;
}

type PragmaFailure = { readonly failure: SqliteFailure; readonly operation: SqliteOperation };

function applyPragmas(
  connection: SqliteConnectionPort,
  busyTimeoutMs: number,
): PragmaFailure | null {
  // Order matters only in that `busy_timeout` should be in effect before
  // anything can contend, which is why it precedes the journal-mode switch.
  const statements = [
    `busy_timeout = ${busyTimeoutMs}`,
    "foreign_keys = ON",
    "journal_mode = WAL",
    // The documented pairing for WAL: a transaction commit does not wait for a
    // full fsync, and the checkpoint does. Not configurable, because a user who
    // turned it off would silently change the durability guarantee this owner
    // exists to hold.
    "synchronous = NORMAL",
  ];
  for (const statement of statements) {
    const applied = connection.pragma(statement);
    if (!applied.ok) {
      return { failure: applied.error, operation: "pragma" };
    }
  }
  return null;
}

/**
 * Probes the file before anything is written to it.
 *
 * Reports problems and stops. Repairing or replacing a database that failed its
 * integrity check is how the only usable copy gets destroyed by a process
 * trying to be helpful.
 */
function checkIntegrity(connection: SqliteConnectionPort): SqliteStoreError | null {
  const checked = connection.pragma("integrity_check");
  if (!checked.ok) {
    return storeErrorForFailure(checked.error, "pragma");
  }
  const problems = checked.value
    .map((row) => textOf(row.integrity_check))
    .filter((line) => line.length > 0 && line !== "ok");
  if (problems.length === 0) {
    return null;
  }
  return storeError({
    code: "integrity-check-failed",
    problems: problems.slice(0, MAX_INTEGRITY_PROBLEMS),
    effect: "none",
  });
}

function boundedBusyTimeout(requested: number | undefined): number {
  const value = requested ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(value)) {
    return DEFAULT_BUSY_TIMEOUT_MS;
  }
  return Math.min(MAX_BUSY_TIMEOUT_MS, Math.max(MIN_BUSY_TIMEOUT_MS, value));
}

type MigrationRun = {
  readonly applied: readonly AppliedMigration[];
  readonly appliedThisRun: readonly number[];
  readonly backupPath: LocalPath | null;
};

/**
 * Opens the connection, brings the schema forward, and returns the store.
 *
 * Asynchronous only because a failure part-way through has to close the
 * connection it opened, and closing is the one operation a shutdown phase must
 * be able to give up on.
 */
export async function openSqliteStore(
  options: SqliteStoreOptions,
  signal?: AbortSignal,
): Promise<Result<SqliteStorePort, SqliteStoreError>> {
  const validated = validateMigrationSet(options.migrations);
  if (!validated.ok) {
    // Refused before anything opened a file. A defective set never reaches a
    // user's database.
    return err(
      storeError({ code: "invalid-migration-set", issues: validated.error, effect: "none" }),
    );
  }

  if (isAborted(signal)) {
    return err(storeError({ code: "cancelled", operation: "open", effect: "none" }));
  }

  const opened = options.open({
    path: options.databasePath,
    create: options.create ?? true,
  });
  if (!opened.ok) {
    return err(storeErrorForFailure(opened.error, "open"));
  }
  const connection = opened.value;

  const fail = async (error: SqliteStoreError): Promise<Result<never, SqliteStoreError>> => {
    await runCloseSequence(connection);
    return err(error);
  };

  // Read before the pragmas, because switching the journal mode writes to a
  // database that a moment ago had no pages at all.
  const created = isEmptyDatabase(connection);

  const pragmaFailure = applyPragmas(connection, boundedBusyTimeout(options.busyTimeoutMs));
  if (pragmaFailure !== null) {
    return fail(storeErrorForFailure(pragmaFailure.failure, pragmaFailure.operation));
  }

  const integrity = checkIntegrity(connection);
  if (integrity !== null) {
    return fail(integrity);
  }

  const migrated = await migrate(connection, options, validated.value, signal);
  if (!migrated.ok) {
    return fail(migrated.error);
  }

  const report: SqliteOpenReport = {
    path: options.databasePath,
    created,
    schemaVersion: migrated.value.applied.reduce(
      (highest, entry) => Math.max(highest, entry.version),
      INITIAL_SCHEMA_VERSION,
    ),
    applied: migrated.value.applied,
    appliedThisRun: migrated.value.appliedThisRun,
    backupPath: migrated.value.backupPath,
  };

  return ok(createStore(connection, report));
}

/**
 * Whether the file had no pages before this run touched it.
 *
 * A cheaper and more truthful answer than asking the filesystem: a zero-length
 * file left behind by a crashed run is also a database with no pages, and both
 * are "there was nothing here" for the purpose of reporting a first run.
 */
function isEmptyDatabase(connection: SqliteConnectionPort): boolean {
  const counted = connection.pragma("page_count");
  return counted.ok && integerOf(counted.value[0]?.page_count) === 0;
}

async function migrate(
  connection: SqliteConnectionPort,
  options: SqliteStoreOptions,
  migrations: readonly Migration[],
  signal: AbortSignal | undefined,
): Promise<Result<MigrationRun, SqliteStoreError>> {
  try {
    connection.run(CREATE_MIGRATION_TABLE);
  } catch (thrown) {
    return err(storeErrorForFailure(failureOfThrown(thrown, "run"), "run"));
  }

  let applied: AppliedMigration[];
  try {
    applied = connection.all(SELECT_APPLIED).map(appliedFromRow);
  } catch (thrown) {
    return err(storeErrorForFailure(failureOfThrown(thrown, "read"), "read"));
  }

  const declaredByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const applicationVersion = latestVersion(migrations);
  const recordedVersion = applied.reduce(
    (highest, entry) => Math.max(highest, entry.version),
    INITIAL_SCHEMA_VERSION,
  );

  if (recordedVersion > applicationVersion) {
    // Refused, and both versions reported — the version the file actually
    // reached, not the first one this build failed to recognize. Falryn does
    // not open it anyway, does not downgrade, and does not delete the only
    // usable copy.
    return err(
      storeError({
        code: "schema-too-new",
        recordedVersion,
        applicationVersion,
        effect: "none",
      }),
    );
  }

  for (const entry of applied) {
    const declared = declaredByVersion.get(entry.version);
    if (declared === undefined) {
      continue;
    }
    const declaredChecksum = migrationChecksum(declared.statements);
    if (declaredChecksum !== entry.checksum) {
      // Never silently re-applied: the database already ran different SQL under
      // this version, and running today's is not a correction.
      return err(
        storeError({
          code: "checksum-mismatch",
          version: entry.version,
          recordedChecksum: entry.checksum,
          declaredChecksum,
          effect: "none",
        }),
      );
    }
  }

  const pending =
    options.applyMigrations === false
      ? []
      : migrations.filter((migration) => migration.version > recordedVersion);
  if (pending.length === 0) {
    return ok({ applied, appliedThisRun: [], backupPath: null });
  }

  let backupPath: LocalPath | null = null;
  if (recordedVersion > INITIAL_SCHEMA_VERSION && pending.some((step) => step.destructive)) {
    // `VACUUM INTO` rather than a serialize-to-memory copy: serializing
    // materializes the whole database in memory, which is the unbounded
    // behavior a backup taken under disk pressure must not have.
    const target = backupPathFor(options.backupDirectory, recordedVersion);
    if (target === null) {
      return err(
        storeError({
          code: "unavailable",
          operation: "backup",
          cause: {
            kind: "sqlite",
            code: "cannot-open",
            operation: "backup",
            driverCode: null,
            detail: "the backup path could not be resolved inside the state root",
          },
          effect: "none",
        }),
      );
    }
    const copied = connection.backupInto(target);
    if (!copied.ok) {
      return err(storeErrorForFailure(copied.error, "backup"));
    }
    backupPath = target;
  }

  const appliedThisRun: number[] = [];
  for (const migration of pending) {
    if (isAborted(signal)) {
      return err(
        appliedThisRun.length === 0
          ? storeError({ code: "cancelled", operation: "transaction", effect: "none" })
          : storeError({
              code: "migration-interrupted",
              recordedVersion: recordedVersion + appliedThisRun.length,
              appliedVersions: [...appliedThisRun],
              backupPath,
              effect: "partial",
            }),
      );
    }

    const outcome = connection.transaction("exclusive", () =>
      applyOne(connection, migration, options),
    );
    if (!outcome.ok) {
      if (outcome.error.code === "busy") {
        // Another process holds the database. Reporting `migration-failed`
        // would say this build's migration is broken, when the answer is to
        // wait for the other process and try again.
        return err(storeErrorForFailure(outcome.error, "transaction"));
      }
      return err(
        storeError({
          code: "migration-failed",
          version: migration.version,
          name: migration.name,
          recordedVersion: recordedVersion + appliedThisRun.length,
          appliedVersions: [...appliedThisRun],
          backupPath,
          cause: outcome.error,
          effect: appliedThisRun.length === 0 ? "none" : "partial",
        }),
      );
    }
    if (outcome.value) {
      appliedThisRun.push(migration.version);
    }
  }

  let finalApplied: AppliedMigration[];
  try {
    finalApplied = connection.all(SELECT_APPLIED).map(appliedFromRow);
  } catch (thrown) {
    return err(storeErrorForFailure(failureOfThrown(thrown, "read"), "read"));
  }

  return ok({ applied: finalApplied, appliedThisRun, backupPath });
}

/**
 * Applies one migration inside the exclusive transaction that already began.
 *
 * The recorded version is re-read here rather than trusted from before the
 * transaction, so two Falryn processes racing the same upgrade cannot both
 * apply it: the second waits its busy timeout at `BEGIN EXCLUSIVE`, then finds
 * the version recorded and does nothing. Returns whether it applied anything.
 */
function applyOne(
  connection: SqliteConnectionPort,
  migration: Migration,
  options: SqliteStoreOptions,
): boolean {
  const rows = connection.all(SELECT_RECORDED_VERSION);
  if (integerOf(rows[0]?.recordedVersion) >= migration.version) {
    return false;
  }

  for (const statement of migration.statements) {
    connection.run(statement);
  }

  connection.run(INSERT_APPLIED, {
    version: migration.version,
    name: migration.name,
    checksum: migrationChecksum(migration.statements),
    appliedAt: options.clock.now(),
  });
  return true;
}

function createStore(connection: SqliteConnectionPort, report: SqliteOpenReport): SqliteStorePort {
  let closing: Promise<SqliteCloseReport> | null = null;

  const statements: SqliteStatements = {
    run: (sql, bindings) => connection.run(sql, bindings),
    all: (sql, bindings) => connection.all(sql, bindings),
  };

  return {
    report,

    read(sql: string, bindings?: SqliteBindings): Result<readonly SqliteRow[], SqliteStoreError> {
      if (closing !== null) {
        return err(storeError({ code: "closed", operation: "read", effect: "none" }));
      }
      try {
        return ok(connection.all(sql, bindings));
      } catch (thrown) {
        return err(storeErrorForFailure(failureOfThrown(thrown, "read"), "read"));
      }
    },

    write<Value>(
      work: (statements: SqliteStatements) => Value,
      signal?: AbortSignal,
    ): Result<SqliteWriteOutcome<Value>, SqliteStoreError> {
      if (closing !== null) {
        return err(storeError({ code: "closed", operation: "transaction", effect: "none" }));
      }
      // Checked before `BEGIN`, which is the last moment at which `cancelled`
      // can still mean "did not commit". A transaction in flight is not
      // interruptible and is short by construction.
      if (isAborted(signal)) {
        return err(storeError({ code: "cancelled", operation: "transaction", effect: "none" }));
      }

      const outcome = connection.transaction("immediate", () => work(statements));
      if (!outcome.ok) {
        return err(storeErrorForFailure(outcome.error, "transaction"));
      }

      // Cancellation that arrived after `COMMIT` did not undo it. Reporting it
      // as `cancelled` would tell a caller nothing happened when something did.
      return ok({ value: outcome.value, cancelledAfterCommit: isAborted(signal) });
    },

    close(): Promise<SqliteCloseReport> {
      closing ??= runCloseSequence(connection);
      return closing;
    },

    backupInto(path: LocalPath, signal?: AbortSignal): Result<null, SqliteStoreError> {
      if (closing !== null) {
        return err(storeError({ code: "closed", operation: "backup", effect: "none" }));
      }
      if (isAborted(signal)) {
        return err(storeError({ code: "cancelled", operation: "backup", effect: "none" }));
      }
      const copied = connection.backupInto(path);
      return copied.ok ? ok(null) : err(storeErrorForFailure(copied.error, "backup"));
    },

    isClosed: () => closing !== null,
  };
}

/**
 * The `close-storage` participant.
 *
 * A close that did not complete throws, which records the participant as
 * failed. A close that never resolves leaves it unfinished, which makes the
 * whole shutdown `uncertain` — the coordinator's existing contract, applied to
 * the first component that has durable state to release.
 */
export function createSqliteShutdownParticipant(store: SqliteStorePort): ShutdownParticipant {
  return {
    name: SQLITE_PARTICIPANT_NAME,
    phase: "close-storage",
    async run(): Promise<void> {
      const report = await store.close();
      if (!isCleanClose(report)) {
        const codes = report.failures.map((failure) => failure.code).join(", ");
        throw new Error(
          `the sqlite close sequence did not complete${codes.length === 0 ? "" : `: ${codes}`}`,
        );
      }
    },
  };
}
