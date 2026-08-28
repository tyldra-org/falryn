import { describe, expect, test } from "bun:test";

import { MAX_MIGRATION_NAME_LENGTH, MAX_MIGRATIONS, type Migration } from "../domain/index.ts";
import { latestVersion, PRODUCTION_MIGRATIONS, validateMigrationSet } from "./sqlite-migrations.ts";

function migration(version: number, name = `step-${version}`): Migration {
  return {
    version,
    name,
    statements: [`CREATE TABLE step_${version} (id INTEGER PRIMARY KEY) STRICT`],
    destructive: false,
  };
}

function codes(migrations: readonly Migration[]): readonly string[] {
  const validated = validateMigrationSet(migrations);
  return validated.ok ? [] : validated.error.map((issue) => issue.code);
}

describe("migration set validation", () => {
  test("accepts a contiguous ascending set", () => {
    const set = [migration(1), migration(2), migration(3)];
    const validated = validateMigrationSet(set);

    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.value).toEqual(set);
  });

  test("accepts an empty set, which is what v0.1 registers", () => {
    expect(validateMigrationSet([]).ok).toBe(true);
  });

  test("refuses a gap at load rather than at run", () => {
    expect(codes([migration(1), migration(3)])).toEqual(["version-gap"]);
  });

  test("refuses a duplicate version", () => {
    expect(codes([migration(1), migration(2), migration(2)])).toEqual(["duplicate-version"]);
  });

  test("refuses a version out of declared order", () => {
    // 1, 3, 2 would apply 2 after 3, which is not what the numbers say happens.
    expect(codes([migration(1), migration(3), migration(2)])).toEqual([
      "version-gap",
      "out-of-order",
    ]);
  });

  test("refuses a version that is not a positive integer", () => {
    expect(codes([migration(0)])).toEqual(["invalid-version"]);
    expect(codes([migration(1.5)])).toEqual(["invalid-version"]);
    expect(codes([migration(-1)])).toEqual(["invalid-version"]);
  });

  test("refuses an unusable name", () => {
    expect(codes([migration(1, "   ")])).toEqual(["invalid-name"]);
    expect(codes([migration(1, "x".repeat(MAX_MIGRATION_NAME_LENGTH + 1))])).toEqual([
      "invalid-name",
    ]);
  });

  test("refuses a migration with no usable SQL", () => {
    const blank: Migration = {
      version: 1,
      name: "blank",
      statements: ["   "],
      destructive: false,
    };
    expect(codes([blank])).toEqual(["empty-statements"]);
  });

  test("refuses a set past the declared bound", () => {
    const oversized = Array.from({ length: MAX_MIGRATIONS + 1 }, (_, index) =>
      migration(index + 1),
    );
    expect(codes(oversized)).toContain("too-many-migrations");
  });

  test("reports every defect at once rather than only the first", () => {
    const defective = [migration(1), migration(1), migration(4)];
    expect(codes(defective)).toEqual(["duplicate-version", "version-gap"]);
  });

  test("names the version and migration a defect belongs to", () => {
    const validated = validateMigrationSet([migration(1), migration(3, "later")]);

    expect(validated.ok).toBe(false);
    expect(!validated.ok && validated.error[0]).toEqual({
      kind: "migration-set",
      code: "version-gap",
      version: 3,
      name: "later",
    });
  });
});

describe("latest version", () => {
  test("is zero for a set that declares nothing", () => {
    expect(latestVersion([])).toBe(0);
  });

  test("is the highest declared version", () => {
    expect(latestVersion([migration(1), migration(2)])).toBe(2);
  });
});

describe("the production set", () => {
  test("is migrations 0001 through 0007, and validates", () => {
    // A real run creates the database, creates the bookkeeping table, verifies
    // integrity, applies the record, artifact, run, and provenance schemas in
    // order, and closes at version 6.
    expect(PRODUCTION_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(validateMigrationSet(PRODUCTION_MIGRATIONS).ok).toBe(true);
  });

  test("creates its tables without being allowed to alter durable data", () => {
    // Non-destructive, which is what lets the runner skip a pre-migration
    // backup: a database at version 0 holds no product row this step can lose.
    expect(PRODUCTION_MIGRATIONS.every((migration) => !migration.destructive)).toBe(true);
  });
});
