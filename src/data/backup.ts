/**
 * Named user backups of the live database, plus local diagnostics.
 *
 * The copy is `VACUUM INTO` through the open store, so it is a consistent
 * snapshot of a live file. Inspecting a backup never upgrades it. Restoring
 * requires the live store to be closed, then moves the live file aside rather
 * than deleting it.
 *
 * Nothing here builds a support bundle or talks to a network.
 */

import {
  type ArtifactStorePort,
  type BackupError,
  type BackupInspection,
  type BackupName,
  type ClockPort,
  type CrashSignals,
  err,
  type FileSystemPort,
  joinPath,
  type LocalDiagnostics,
  type LocalPath,
  type Migration,
  NO_CRASH_SIGNALS,
  ok,
  parentPath,
  type RestoreResult,
  type Result,
  type SqliteOpener,
  type SqliteStoreError,
  type SqliteStorePort,
  type UserBackup,
  userBackupFileName,
} from "../domain/index.ts";
import { openSqliteStore } from "./sqlite-store.ts";

export type BackupOptions = {
  readonly store: SqliteStorePort;
  readonly fileSystem: FileSystemPort;
  readonly backupDirectory: LocalPath;
  readonly databasePath: LocalPath;
  readonly open: SqliteOpener;
  readonly clock: ClockPort;
  readonly migrations: readonly Migration[];
  readonly artifacts?: ArtifactStorePort;
  readonly crashSignals?: CrashSignals;
};

const cancelled: BackupError = { kind: "backup", code: "cancelled" };

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function fromStore(error: SqliteStoreError): BackupError {
  return { kind: "backup", code: "store", error };
}

function backupFile(options: BackupOptions, name: BackupName): Result<LocalPath, BackupError> {
  const joined = joinPath(options.backupDirectory, userBackupFileName(name));
  return joined.ok ? ok(joined.value) : err({ kind: "backup", code: "path", error: joined.error });
}

/**
 * Writes a named consistent copy of the live database.
 *
 * An existing target is refused. The adapter leaves the copy owner-only.
 */
export function createUserBackup(
  options: BackupOptions,
  name: BackupName,
  signal?: AbortSignal,
): Result<UserBackup, BackupError> {
  if (aborted(signal)) {
    return err(cancelled);
  }
  const path = backupFile(options, name);
  if (!path.ok) {
    return path;
  }
  const copied = options.store.backupInto(path.value, signal);
  if (!copied.ok) {
    return err(fromStore(copied.error));
  }
  return ok({ name, schemaVersion: options.store.report.schemaVersion });
}

/**
 * Opens a backup without applying migrations, then closes it.
 *
 * A backup that this build is too old to read is still refused as
 * `schema-too-new`. An older backup is reported, not upgraded.
 */
export async function inspectUserBackup(
  options: BackupOptions,
  name: BackupName,
  signal?: AbortSignal,
): Promise<Result<BackupInspection, BackupError>> {
  if (aborted(signal)) {
    return err(cancelled);
  }
  const path = backupFile(options, name);
  if (!path.ok) {
    return path;
  }
  const stated = await options.fileSystem.stat(path.value, signal);
  if (!stated.ok) {
    return err({ kind: "backup", code: "filesystem", error: stated.error });
  }
  if (stated.value === null) {
    return err({ kind: "backup", code: "not-found" });
  }
  const opened = await openSqliteStore(
    {
      open: options.open,
      clock: options.clock,
      databasePath: path.value,
      backupDirectory: options.backupDirectory,
      migrations: options.migrations,
      create: false,
      applyMigrations: false,
    },
    signal,
  );
  if (!opened.ok) {
    return err(fromStore(opened.error));
  }
  const schemaVersion = opened.value.report.schemaVersion;
  const byteLength = stated.value.kind === "file" ? stated.value.byteLength : 0;
  await opened.value.close();
  return ok({ name, schemaVersion, byteLength });
}

/**
 * Replaces the live database with a verified backup.
 *
 * The live store must already be closed. The previous live file is renamed
 * aside rather than deleted.
 */
export async function restoreUserBackup(
  options: BackupOptions,
  name: BackupName,
  signal?: AbortSignal,
): Promise<Result<RestoreResult, BackupError>> {
  if (aborted(signal)) {
    return err(cancelled);
  }
  if (!options.store.isClosed()) {
    return err({ kind: "backup", code: "live-store-open" });
  }
  const inspected = await inspectUserBackup(options, name, signal);
  if (!inspected.ok) {
    return inspected;
  }
  const source = backupFile(options, name);
  if (!source.ok) {
    return source;
  }
  const parent = parentPath(options.databasePath);
  if (parent === null) {
    return err({
      kind: "backup",
      code: "path",
      error: { kind: "local-path", code: "path-escapes-root" },
    });
  }
  const previous = joinPath(parent, "falryn.sqlite.previous");
  if (!previous.ok) {
    return err({ kind: "backup", code: "path", error: previous.error });
  }
  const live = await options.fileSystem.stat(options.databasePath, signal);
  if (!live.ok) {
    return err({ kind: "backup", code: "filesystem", error: live.error });
  }
  if (live.value !== null) {
    const moved = await options.fileSystem.renameEntry(
      options.databasePath,
      previous.value,
      signal,
    );
    if (!moved.ok) {
      return err({ kind: "backup", code: "filesystem", error: moved.error });
    }
  }
  const copied = await options.fileSystem.copyEntry(source.value, options.databasePath, signal);
  if (!copied.ok) {
    return err({ kind: "backup", code: "filesystem", error: copied.error });
  }
  return ok({ name, schemaVersion: inspected.value.schemaVersion });
}

/** Local facts a support workflow can read. Never a bundle, never a network. */
export async function collectLocalDiagnostics(
  options: BackupOptions,
  signal?: AbortSignal,
): Promise<Result<LocalDiagnostics, BackupError>> {
  if (aborted(signal)) {
    return err(cancelled);
  }
  const sweep = options.artifacts === undefined ? null : await options.artifacts.sweep(signal);
  return ok({
    schemaVersion: options.store.report.schemaVersion,
    crashSignals: options.crashSignals ?? NO_CRASH_SIGNALS,
    sweep,
  });
}
