/**
 * Negative controls over the database boundary.
 *
 * These assert absences, which is the only way to keep a boundary that costs
 * nothing to cross by accident. A second `Database`, a driver import in a
 * service, or a query embedded in a provider would each work perfectly on the
 * day it was written and would each remove the guarantee that one owner
 * serializes migrations and transactions.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";

const SOURCE_ROOT = dirname(import.meta.path);

/** The one module allowed to speak to the driver. */
const ADAPTER = "integrations/bun-sqlite.ts";

/** This control file names every forbidden token, so it excludes itself. */
const SELF = "sqlite-boundaries.test.ts";

/** The area allowed to author SQL. Its migration list lives beside it. */
const SQL_OWNER = "data/";

async function sourceFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: SOURCE_ROOT })) {
    files.push(entry);
  }
  return files.sort();
}

async function readSource(file: string): Promise<string> {
  return readFile(`${SOURCE_ROOT}/${file}`, "utf8");
}

/** Files that are neither tests nor fixtures — the ones that ship. */
function isProduct(file: string): boolean {
  return !file.endsWith(".test.ts") && !file.endsWith("fixtures.ts");
}

describe("the driver import", () => {
  test("appears only in the adapter", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (file === ADAPTER || file === SELF) {
        continue;
      }
      if ((await readSource(file)).includes(`from "bun:sqlite"`)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("is present in the adapter, so this control is testing something", async () => {
    expect(await readSource(ADAPTER)).toContain(`from "bun:sqlite"`);
  });
});

describe("the connection", () => {
  test("is constructed exactly once in the whole tree", async () => {
    const constructions: string[] = [];
    for (const file of await sourceFiles()) {
      if (file === SELF) {
        continue;
      }
      const source = await readSource(file);
      const matches = source.match(/new Database\(/g);
      for (const _ of matches ?? []) {
        constructions.push(file);
      }
    }
    // A second connection would be a second answer to write ordering, busy
    // handling, and shutdown, which are owned centrally on purpose.
    expect(constructions).toEqual([ADAPTER]);
  });
});

describe("SQL", () => {
  test("is authored only by the data area", async () => {
    // The adapter is exempt for the two statements it must name to implement
    // its own port operations, asserted separately below.
    const statement =
      /\b(CREATE\s+TABLE|CREATE\s+INDEX|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE|SELECT\s+[\w*]+\s+FROM)\b/i;
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file.startsWith(SQL_OWNER) || file === ADAPTER) {
        continue;
      }
      if (statement.test(await readSource(file))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("names no table or column inside the adapter", async () => {
    const source = await readSource(ADAPTER);

    // The adapter speaks statements it is handed. `PRAGMA` and `VACUUM INTO`
    // are the only two it composes, because they are the operations its port
    // declares rather than queries over a schema.
    expect(source).not.toMatch(/\b(CREATE\s+TABLE|INSERT\s+INTO|SELECT\s+\w+\s+FROM)\b/i);
    expect(source).not.toContain("falryn_schema_migrations");
  });
});

describe("the whole-database copy", () => {
  test("is taken with VACUUM INTO and never by serializing into memory", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file)) {
        continue;
      }
      if ((await readSource(file)).includes(".serialize(")) {
        offenders.push(file);
      }
    }
    // Serializing materializes the whole database in memory, which is the
    // unbounded behavior a backup taken under disk pressure must not have.
    expect(offenders).toEqual([]);
    expect(await readSource(ADAPTER)).toContain("VACUUM INTO");
  });
});

describe("the source tree", () => {
  test("keeps the database owner inside the data area", async () => {
    const owners = (await sourceFiles()).filter(
      (file) => isProduct(file) && file.includes("sqlite-store"),
    );

    expect(owners.map((file) => relative(SQL_OWNER, file))).toEqual(["sqlite-store.ts"]);
  });
});

describe("the event store", () => {
  test("has exactly one durable implementation", async () => {
    const implementations: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file === SELF) {
        continue;
      }
      if ((await readSource(file)).includes("EventStorePort = {")) {
        implementations.push(file);
      }
    }
    // The port is declared once. A second declaration would be a second
    // persistence interface, which is exactly what the port exists to prevent.
    expect(implementations).toEqual(["domain/event-store.ts"]);

    const factories: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file === SELF) {
        continue;
      }
      const source = await readSource(file);
      if (source.includes("export function createSqliteEventStore")) {
        factories.push(file);
      }
    }
    expect(factories).toEqual(["data/event-store.ts"]);
  });

  test("keeps the in-memory double in the domain, as a double", async () => {
    // Neither deleted nor promoted to a fallback: it is what lets everything
    // above persistence be tested without a disk.
    expect(await readSource("domain/event-store.ts")).toContain(
      "export function createInMemoryEventStore",
    );
  });
});

describe("row shapes and the database handle", () => {
  test("reach no provider, UI, extension, or agent path", async () => {
    // The three tokens that would mean a caller is holding storage rather than
    // records: a row, a statement, and the store itself.
    const storageTokens = /\b(SqliteRow|SqliteStatements|SqliteStorePort|SqliteBindings)\b/;
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file === SELF) {
        continue;
      }
      if (file.startsWith("domain/") || file.startsWith(SQL_OWNER) || file === ADAPTER) {
        continue;
      }
      if (storageTokens.test(await readSource(file))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("do not appear in the composition root either", async () => {
    // The bootstrap wires the store into its owners and never reads a row
    // itself, so it has no reason to name one.
    const source = await readSource("main.ts");
    expect(source).not.toMatch(/\b(SqliteRow|SqliteStatements)\b/);
  });
});

describe("the product tables", () => {
  test("are named only by the area that owns their SQL", async () => {
    // Snake-cased identifiers only. `sessions` and `turns` are also ordinary
    // English, so matching them would flag prose rather than a leaked schema.
    const tables =
      /\b(model_attempts|projection_cursors|stream_id|outcome_kind|outcome_effect|input_digest|last_applied_sequence)\b/;
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file === SELF || file.startsWith(SQL_OWNER)) {
        continue;
      }
      if (tables.test(await readSource(file))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
