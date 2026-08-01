/**
 * The registered migration set, and the rules a set has to satisfy to be run.
 *
 * Validation happens at load, against the declared list alone, before anything
 * opens a database. That ordering is the point: a build whose migrations have a
 * gap, a repeat, or a version out of order is defective, and finding out
 * halfway through applying it means finding out on a user's only copy.
 *
 * The production list is empty at v0.1. A real run creates the database,
 * creates the runner's bookkeeping table, verifies integrity, and closes at
 * schema version 0. Migration `0001` — sessions, turns, events, and their
 * indexes — belongs to the issue that designs those tables, which is why this
 * one delivers the runner and its fixtures rather than a schema.
 */

import {
  err,
  MAX_MIGRATION_NAME_LENGTH,
  MAX_MIGRATIONS,
  type Migration,
  type MigrationSetError,
  type MigrationSetErrorCode,
  ok,
  type Result,
} from "../domain/index.ts";

/**
 * The migrations this build applies.
 *
 * Colocated with the runner as TypeScript rather than kept in a `.sql` tree,
 * because `bun build --compile` must provably contain the SQL: a file tree
 * needs a loader to be embedded, and a migration missing from the standalone
 * executable would surface as a database that silently looks unmigrated.
 */
export const PRODUCTION_MIGRATIONS: readonly Migration[] = [];

function issue(
  code: MigrationSetErrorCode,
  version: number | null,
  name: string | null,
): MigrationSetError {
  return { kind: "migration-set", code, version, name };
}

/**
 * Checks a declared set and returns it unchanged, or every defect it has.
 *
 * All defects are reported rather than the first, because a defective set is
 * corrected once by an author reading a list, not once per rebuild.
 */
export function validateMigrationSet(
  migrations: readonly Migration[],
): Result<readonly Migration[], readonly MigrationSetError[]> {
  const issues: MigrationSetError[] = [];

  if (migrations.length > MAX_MIGRATIONS) {
    issues.push(issue("too-many-migrations", null, null));
  }

  const seen = new Set<number>();
  let previousVersion = 0;

  for (const migration of migrations) {
    const { version, name } = migration;

    if (!Number.isSafeInteger(version) || version < 1) {
      issues.push(issue("invalid-version", null, name));
      continue;
    }
    if (name.trim().length === 0 || name.length > MAX_MIGRATION_NAME_LENGTH) {
      issues.push(issue("invalid-name", version, null));
    }
    if (migration.statements.length === 0 || migration.statements.some(isBlank)) {
      issues.push(issue("empty-statements", version, name));
    }
    if (seen.has(version)) {
      issues.push(issue("duplicate-version", version, name));
      continue;
    }
    seen.add(version);

    if (version <= previousVersion) {
      // Declared order is the applied order. A set that reads 1, 3, 2 would
      // apply 2 after 3, which is not what the numbers say happens.
      issues.push(issue("out-of-order", version, name));
    } else if (version !== previousVersion + 1) {
      // Contiguity is what makes a recorded version comparable to a declared
      // one: with a gap, "recorded 4, declared up to 6" no longer says how many
      // steps are outstanding.
      issues.push(issue("version-gap", version, name));
    }
    previousVersion = version;
  }

  return issues.length === 0 ? ok(migrations) : err(issues);
}

function isBlank(statement: string): boolean {
  return statement.trim().length === 0;
}

/** The highest version a validated set can bring a database to. */
export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((highest, migration) => Math.max(highest, migration.version), 0);
}
