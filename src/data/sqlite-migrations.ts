/**
 * The registered migration set, and the rules a set has to satisfy to be run.
 *
 * Validation happens at load, against the declared list alone, before anything
 * opens a database. That ordering is the point: a build whose migrations have a
 * gap, a repeat, or a version out of order is defective, and finding out
 * halfway through applying it means finding out on a user's only copy.
 *
 * The production list holds three steps: migration `0001`, which creates the
 * session, turn, model-attempt, invocation, event, and projection-cursor
 * tables, migration `0002`, which creates the artifact metadata table, and
 * migration `0003`, which creates run identity. Their SQL lives in
 * `schema.ts`, `artifact-schema.ts`, and `run-schema.ts` beside this list, so
 * this module stays the rules a set must satisfy and those stay the schema.
 *
 * The aggregate view of what the set produces — every product table and the
 * version a fully migrated database reports — lives here rather than in either
 * schema module, because neither one can answer it alone.
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
import { ARTIFACTS_TABLE, MIGRATION_0002 } from "./artifact-schema.ts";
import { MIGRATION_0003, RUNS_TABLE } from "./run-schema.ts";
import { MIGRATION_0001, RECORD_TABLES } from "./schema.ts";

/**
 * The migrations this build applies.
 *
 * Colocated with the runner as TypeScript rather than kept in a `.sql` tree,
 * because `bun build --compile` must provably contain the SQL: a file tree
 * needs a loader to be embedded, and a migration missing from the standalone
 * executable would surface as a database that silently looks unmigrated.
 */
export const PRODUCTION_MIGRATIONS: readonly Migration[] = [
  MIGRATION_0001,
  MIGRATION_0002,
  MIGRATION_0003,
];

/** Every product table the registered set creates, in creation order. */
export const PRODUCT_TABLES: readonly string[] = [...RECORD_TABLES, ARTIFACTS_TABLE, RUNS_TABLE];

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

/** The version a fully migrated database reports. Derived, never restated. */
export const PRODUCT_SCHEMA_VERSION = latestVersion(PRODUCTION_MIGRATIONS);
