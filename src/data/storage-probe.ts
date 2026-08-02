/**
 * A read-only look at the database on disk.
 *
 * `openSqliteStore` is the normal way in and it *migrates*: it creates the file
 * when it is absent and applies every pending migration. That is right for a
 * run that is about to use storage and wrong for a command that is only
 * describing it — `reference/CLI.md` requires diagnostics not to mutate, and
 * creating a database as a side effect of being asked whether one exists is
 * exactly that.
 *
 * So this opens with `create: false`, reads the migration bookkeeping, and
 * closes. An absent database is a reportable state, not a failure.
 *
 * It lives in the data area because the data area authors SQL. A caller reads
 * the report; it never sees a row, a statement, or a connection.
 */

import type { LocalPath, SqliteOpener } from "../domain/index.ts";
import { PRODUCT_SCHEMA_VERSION } from "./sqlite-migrations.ts";
import { MIGRATION_TABLE } from "./sqlite-store.ts";

export type StorageProbe =
  /** No database exists yet. The first run that needs one will create it. */
  | { readonly kind: "absent" }
  | {
      readonly kind: "present";
      /** The highest migration version recorded in the file. */
      readonly schemaVersion: number;
      /** The version this build migrates to. */
      readonly expectedVersion: number;
      /**
       * Whether the file is at the version this build expects.
       *
       * `false` in both directions: a database behind this build needs
       * migrating, and one ahead of it was written by a newer Falryn and must
       * not be opened for writing by this one.
       */
      readonly current: boolean;
    }
  /** A database exists and could not be read. Carries the boundary's own code. */
  | { readonly kind: "unreadable"; readonly code: string };

export type StorageProbeOptions = {
  readonly open: SqliteOpener;
  readonly databasePath: LocalPath;
};

/** What the database at this path reports about itself, without changing it. */
export async function probeStorage(options: StorageProbeOptions): Promise<StorageProbe> {
  // `create: false` is the whole contract. With it, a missing file is an open
  // failure rather than a new database, which is what keeps this read-only.
  const opened = options.open({ path: options.databasePath, create: false });
  if (!opened.ok) {
    // `cannot-open` is what the driver reports for a file that is not there
    // when it was told not to create one. Every other code means a database
    // exists and something else went wrong, which is a different answer.
    return opened.error.code === "cannot-open"
      ? { kind: "absent" }
      : { kind: "unreadable", code: opened.error.code };
  }

  const connection = opened.value;
  try {
    const rows = connection.all(
      `SELECT COALESCE(MAX(version), 0) AS recordedVersion FROM ${MIGRATION_TABLE}`,
    );
    const recorded = versionIn(rows);
    return {
      kind: "present",
      schemaVersion: recorded,
      expectedVersion: PRODUCT_SCHEMA_VERSION,
      current: recorded === PRODUCT_SCHEMA_VERSION,
    };
  } catch (error) {
    // A file that exists but has no migration table is not a Falryn database,
    // or is one that was interrupted before its first migration landed.
    // Either way it is unreadable rather than absent.
    return { kind: "unreadable", code: codeOf(error) };
  } finally {
    await connection.close();
  }
}

/** The recorded version in a single-row result, or zero when there is none. */
function versionIn(rows: readonly Record<string, unknown>[]): number {
  const value = rows[0]?.recordedVersion;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    if (typeof code === "string") {
      return code;
    }
  }
  return "unknown";
}
