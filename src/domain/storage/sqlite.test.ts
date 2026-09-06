import { describe, expect, test } from "bun:test";

import {
  isCleanClose,
  MAX_SQLITE_DETAIL_LENGTH,
  migrationChecksum,
  type SqliteCloseReport,
  type SqliteFailure,
  SqliteWorkError,
} from "./sqlite.ts";

const CLEAN: SqliteCloseReport = {
  persistentWalDisabled: true,
  checkpointed: true,
  closed: true,
  failures: [],
};

const FAILURE: SqliteFailure = {
  kind: "sqlite",
  code: "busy",
  operation: "close",
  driverCode: "SQLITE_BUSY",
  detail: null,
};

describe("migration checksum", () => {
  test("is stable for the same statements", () => {
    expect(migrationChecksum(["CREATE TABLE a (x INTEGER)"])).toBe(
      migrationChecksum(["CREATE TABLE a (x INTEGER)"]),
    );
  });

  test("changes when a statement changes", () => {
    expect(migrationChecksum(["CREATE TABLE a (x INTEGER)"])).not.toBe(
      migrationChecksum(["CREATE TABLE a (x TEXT)"]),
    );
  });

  test("distinguishes a different split of the same text", () => {
    // The separator is what makes this true. Without it both inputs hash the
    // same concatenation, and a migration could be silently restructured.
    expect(migrationChecksum(["ab", "c"])).not.toBe(migrationChecksum(["a", "bc"]));
  });

  test("is a fixed-width lowercase hexadecimal digest", () => {
    expect(migrationChecksum(["SELECT 1"])).toMatch(/^[0-9a-f]{16}$/);
  });

  test("distinguishes order", () => {
    expect(migrationChecksum(["one", "two"])).not.toBe(migrationChecksum(["two", "one"]));
  });
});

describe("close report", () => {
  test("is clean only when every step ran and nothing failed", () => {
    expect(isCleanClose(CLEAN)).toBe(true);
    expect(isCleanClose({ ...CLEAN, checkpointed: false })).toBe(false);
    expect(isCleanClose({ ...CLEAN, closed: false })).toBe(false);
    expect(isCleanClose({ ...CLEAN, persistentWalDisabled: false })).toBe(false);
  });

  test("is not clean when a step reported a failure it recovered from", () => {
    expect(isCleanClose({ ...CLEAN, failures: [FAILURE] })).toBe(false);
  });
});

describe("transaction work error", () => {
  test("carries the classification the adapter already made", () => {
    const thrown = new SqliteWorkError(FAILURE);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.failure).toEqual(FAILURE);
    expect(thrown.name).toBe("SqliteWorkError");
  });
});

describe("declared bounds", () => {
  test("bound the driver detail rather than leaving it open", () => {
    expect(MAX_SQLITE_DETAIL_LENGTH).toBeGreaterThan(0);
  });
});
