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

describe("artifact bytes", () => {
  /** The one module allowed to write them. */
  const BLOB_ADAPTER = "integrations/host-blobs.ts";

  test("are written in exactly one adapter module", async () => {
    // The three ways a module could hold a byte stream of its own: an open
    // handle, a whole-file write, and a stream. Any of them outside the adapter
    // would be a second answer to where artifact bytes live. The package
    // adapter is exempt because it writes packages, not artifacts; that its
    // own bytes stay in one module is asserted separately below.
    const byteWriters = /\b(fs\.open|open\(|writeFile|createWriteStream|Bun\.write)\b/;
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (
        !isProduct(file) ||
        file === SELF ||
        file === BLOB_ADAPTER ||
        file === "integrations/host-packages.ts"
      ) {
        continue;
      }
      if (byteWriters.test(await readSource(file))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("are reachable only by scope and digest, never by path", async () => {
    // `BlobLocation` names a scope and a digest. A module that turned one into
    // a path would put that path into an error, an event, or a diagnostic.
    const source = await readSource("data/artifact-store.ts");
    expect(source).not.toMatch(/\b(LocalPath|joinPath|localPath)\b/);
    expect(await readSource("domain/blob.ts")).not.toMatch(/\bLocalPath\b/);
  });

  test("have one artifact store and one blob port declaration", async () => {
    const ports: string[] = [];
    const stores: string[] = [];
    for (const file of await sourceFiles()) {
      if (!isProduct(file) || file === SELF) {
        continue;
      }
      const source = await readSource(file);
      if (source.includes("BlobStorePort = {")) {
        ports.push(file);
      }
      if (source.includes("export function createArtifactStore")) {
        stores.push(file);
      }
    }
    expect(ports).toEqual(["domain/blob.ts"]);
    expect(stores).toEqual(["data/artifact-store.ts"]);
  });
});

describe("an artifact failure", () => {
  test("carries no digest, path, or byte in any declared member", async () => {
    const artifactErrors = /code: "(malformed-row|storage|already-exists|not-found)"/;
    const source = await readSource("domain/artifact.ts");
    const union = source.slice(
      source.indexOf("export type ArtifactError"),
      source.indexOf("/** What a caller declares"),
    );

    expect(artifactErrors.test(source) || union.length > 0).toBe(true);
    // A digest or a byte array in a failure is content in something meant to be
    // loggable. A byte length and an offset are structure, and are allowed.
    expect(union).not.toMatch(/readonly (digest|bytes|content|path):/);
  });
});

describe("startup recovery", () => {
  const RECOVERY = "data/recovery.ts";

  test("deletes no record, whatever it concludes", async () => {
    const source = await readSource(RECOVERY);
    // It marks, it moves an availability, and it discards bytes. A `DELETE`
    // here would be recovery destroying the evidence it exists to describe.
    expect(source).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(source).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  test("never writes a failure where it observed none", async () => {
    const source = await readSource(RECOVERY);
    // Interrupted work is `uncertain`, never `failed`: failure is an
    // observation and this is the absence of one.
    expect(source).toContain(`kind: "uncertain", effect: "uncertain"`);
    expect(source).not.toContain(`kind: "failed"`);
  });

  test("reports counts, and no path, digest, or byte", async () => {
    const source = await readSource("domain/run.ts");
    const report = source.slice(
      source.indexOf("export type RecoveryReport"),
      source.indexOf("export type RecoveryError"),
    );
    expect(report.length).toBeGreaterThan(0);
    expect(report).not.toMatch(/readonly (path|digest|bytes|content):/);
  });

  test("performs no external effect", async () => {
    const source = await readSource(RECOVERY);
    // No process, no network, no host command. Recovery reads durable state
    // and writes durable state; anything else would be re-running the work it
    // is describing.
    expect(source).not.toMatch(/\b(CommandRunnerPort|Bun\.spawn|child_process|fetch\()\b/);
  });
});

describe("an export package", () => {
  const EXPORT = "data/export.ts";
  /** The one module allowed to write one. */
  const PACKAGE_ADAPTER = "integrations/host-packages.ts";

  test("is written in exactly one adapter module", async () => {
    const byteWriters = /\b(fs\.open|writeFile|createWriteStream|Bun\.write)\b/;
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (
        !isProduct(file) ||
        file === SELF ||
        file === PACKAGE_ADAPTER ||
        file === "integrations/host-blobs.ts"
      ) {
        continue;
      }
      if (byteWriters.test(await readSource(file))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("is reached by name, never by path", async () => {
    // A package is named and the adapter decides where that lands, so no path
    // type reaches the service that decides what goes into one.
    const source = await readSource(EXPORT);
    expect(source).not.toMatch(/\b(LocalPath|joinPath|localPath)\b/);
    expect(await readSource("domain/package.ts")).not.toMatch(/\bLocalPath\b/);
  });

  test("can never reach a credential", async () => {
    // Not a policy the writer applies — a reachability fact. Nothing in the
    // export path names the credential vocabulary at all, so no selection can
    // route one into a package.
    const credentials =
      /\b(CredentialStorePort|SecretResolverPort|CredentialReference|SecretRequest)\b/;
    for (const file of [EXPORT, "domain/export.ts", "domain/package.ts", PACKAGE_ADAPTER]) {
      expect(credentials.test(await readSource(file))).toBe(false);
    }
  });

  test("refuses restricted artifacts by vocabulary rather than by flag", async () => {
    const source = await readSource(EXPORT);
    // The check exists, and it is made before the sensitivity opt-in is
    // consulted, so a selection cannot opt back into content the label says
    // never leaves the machine.
    const decision = source.slice(
      source.indexOf("function decide("),
      source.indexOf("function resolveSessions("),
    );
    expect(decision).toContain(`"restricted"`);
    // Decided before the sensitivity opt-in is consulted, so a selection cannot
    // opt back into content the label says never leaves the machine.
    expect(decision.indexOf(`=== "restricted"`)).toBeLessThan(decision.indexOf(`=== "sensitive"`));
  });

  test("performs no external effect beyond its own destination", async () => {
    const source = await readSource(EXPORT);
    expect(source).not.toMatch(/\b(CommandRunnerPort|Bun\.spawn|child_process|fetch\()\b/);
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
