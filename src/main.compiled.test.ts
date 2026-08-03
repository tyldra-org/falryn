/**
 * The compiled smoke check.
 *
 * `bun build --compile` is the shape Falryn ships in, and it is the shape a
 * migration can silently go missing from — SQL kept in a file tree needs a
 * loader to be embedded, and a database that looks unmigrated is a failure a
 * source-mode test cannot see. So the standalone executable opens, migrates,
 * and closes against a temporary state root here, and the resulting file is
 * inspected rather than assumed.
 *
 * The check reports itself as skipped when `dist/falryn` has not been built,
 * rather than passing on the strength of an executable that does not exist.
 * `bun run ci` builds before it tests, so a release path always runs it.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_SCHEMA_FAMILY, EXIT_CODES, FALRYN_VERSION, readCliStream } from "./cli/index.ts";
import { MIGRATION_TABLE, PRODUCT_SCHEMA_VERSION, PRODUCT_TABLES } from "./data/index.ts";
import { createStaticEnvironment, type LocalPath, localPath } from "./domain/index.ts";
import { openBunSqlite } from "./integrations/index.ts";
import { main } from "./main.ts";

const EXECUTABLE = join(dirname(dirname(import.meta.path)), "dist", "falryn");

/** The bootstrap fixture this file compiles itself, and where it puts it. */
const BOOTSTRAP_ENTRY = join(dirname(import.meta.path), "main-fixtures.ts");
const BOOTSTRAP_BINARY = join(tmpdir(), "falryn-bootstrap-probe");

const roots: string[] = [];

async function temporaryRoot(): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), "falryn-compiled-"));
  roots.push(created);
  return localPath(created);
}

afterAll(async () => {
  // The fixture binary is built into the system temp directory, not a root, so
  // it outlives the per-test cleanup below unless it is named here.
  await rm(BOOTSTRAP_BINARY, { force: true });
});

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

const built = await stat(EXECUTABLE)
  .then(() => true)
  .catch(() => false);

/**
 * How long one compiled run may take.
 *
 * Covers process start, migration, and close on a loaded machine, and nothing
 * more. It no longer has to absorb a shutdown wait: the coordinator releases a
 * phase's deadline timer when the phase ends, so a run exits as soon as its
 * work is done. `src/main.test.ts` is what measures that latency.
 */
const COMPILED_RUN_TIMEOUT_MS = 10_000;

/** A run that also compiles. Covers `bun build --compile` on a loaded machine. */
const COMPILED_BUILD_TIMEOUT_MS = 60_000;

function spawnCompiled(
  root: LocalPath,
  args: readonly string[] = [],
): { exitCode: number; stdout: string; stderr: string } {
  // Synchronous on purpose: the child writes nothing, and an asynchronous spawn
  // whose pipes nobody drains can block on a full buffer rather than exiting.
  const finished = Bun.spawnSync([EXECUTABLE, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      FALRYN_STATE_DIR: root,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: finished.exitCode,
    stdout: finished.stdout.toString(),
    stderr: finished.stderr.toString(),
  };
}

describe.if(built)("the standalone executable", () => {
  test(
    "runs the CLI, and a bare invocation prints help without opening a database",
    async () => {
      // #17 made `falryn` a command tree, so the bare invocation is no longer
      // the storage bootstrap. #23 gave it a shell, and this is the run that
      // cannot have one: the spawn's handles are pipes, so the launch decision
      // refuses and the invocation keeps exactly the behavior it had before —
      // help on stdout, exit 0. That it creates no file is the compiled proof
      // of `reference/CLI.md`'s rule that help initializes nothing.
      const root = await temporaryRoot();
      const finished = spawnCompiled(root);

      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      expect(finished.stdout).toContain("falryn [command] [options]");
      // The named reason, on the diagnostic handle and nowhere else. stdout
      // carries the selected result format, so a run redirecting it gets help
      // and not a notice about terminals.
      expect(finished.stderr).toContain("needs a terminal on standard input");
      expect(finished.stdout).not.toContain("needs a terminal");
      expect(await readdir(root)).toEqual([]);
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "reports its build identity, naming the compiled mode",
    async () => {
      const root = await temporaryRoot();
      const finished = spawnCompiled(root, ["--version"]);

      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      // The mode is the fact a bug report needs first, and it is the one that
      // can only be observed here: a source run reports `source`.
      expect(finished.stdout).toContain("compiled build");
      expect(finished.stdout).toContain(`falryn ${FALRYN_VERSION}`);
      expect(await readdir(root)).toEqual([]);
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "refuses an invalid invocation on stderr with the invalid-usage code",
    async () => {
      const root = await temporaryRoot();
      const finished = spawnCompiled(root, ["--nope"]);

      expect(finished.exitCode).toBe(EXIT_CODES.INVALID_USAGE);
      // stdout carries results only. An invocation with no result writes
      // nothing to it, even though it has plenty to say on stderr.
      expect(finished.stdout).toBe("");
      expect(finished.stderr).toContain("Unknown argument: nope");
      expect(await readdir(root)).toEqual([]);
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "runs doctor over a temporary root without creating anything",
    async () => {
      const root = await temporaryRoot();
      const finished = spawnCompiled(root, ["doctor"]);

      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      // #18 renders the result, so stdout carries the report and stderr the
      // status. The separation is what a compiled run has to keep too.
      expect(finished.stdout).toContain("Falryn diagnostics");
      expect(finished.stdout).not.toContain("Completed.");
      expect(finished.stderr).toContain("Completed.");
      // Diagnostics describe roots; they do not create them.
      expect(await readdir(root)).toEqual([]);
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "emits one parseable machine record from a standalone executable",
    async () => {
      // The compiled path is where a schema constant or a Zod parser can go
      // missing without a source-mode test noticing.
      const root = await temporaryRoot();
      const finished = spawnCompiled(root, ["doctor", "--format", "json"]);

      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      const reading = readCliStream(finished.stdout.split("\n"));
      expect(reading.terminal?.kind).toBe("result");
      expect(reading.refusals).toEqual([]);
      expect(reading.terminal?.schemaFamily).toBe(CLI_SCHEMA_FAMILY);
      // stdout holds the record and nothing else.
      expect(finished.stderr).toBe("");
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "emits a whole JSON Lines stream from a standalone executable",
    async () => {
      const root = await temporaryRoot();
      const finished = spawnCompiled(root, ["config", "show", "--format", "jsonl"]);

      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      const reading = readCliStream(finished.stdout.split("\n"));
      expect(reading.terminal?.kind).toBe("result");
      expect(reading.gaps).toEqual([]);
      expect(reading.refusals).toEqual([]);
      // Every line stands alone, which is what makes the stream consumable a
      // record at a time rather than only in full.
      for (const line of finished.stdout.split("\n").filter((entry) => entry !== "")) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "reads the migration bookkeeping out of a database it did not create",
    async () => {
      // Restores what #17 briefly cost: the compiled binary agreeing with the
      // schema this build declares. The database is created by the source
      // bootstrap, because no compiled path applies migrations any more — the
      // bare invocation is the command tree now.
      const root = await temporaryRoot();
      await main({
        platform: "darwin",
        home: root,
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: root }),
      });
      expect(await readdir(root)).toContain("falryn.sqlite");

      const finished = spawnCompiled(root, ["doctor"]);
      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);

      // The compiled binary carries PRODUCT_SCHEMA_VERSION and can read the
      // migration table. A version constant that failed to survive packaging,
      // or a table it could not read, fails here.
      expect(finished.stdout).toContain(
        `schema ${PRODUCT_SCHEMA_VERSION} of ${PRODUCT_SCHEMA_VERSION}, current`,
      );
      // A database that is behind or ahead is a finding, and there is none.
      expect(finished.stderr).not.toContain("this build expects");
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "applies every migration inside a standalone executable",
    async () => {
      // The coverage #17 briefly cost, restored rather than deferred. The bare
      // invocation is the command tree now, so the bootstrap is compiled from
      // its own fixture entry — the pattern `src/cli/probe-fixtures.ts` uses.
      // SQL kept in a file tree needs a loader to be embedded, and a database
      // that looks unmigrated is a failure source mode cannot see.
      const root = await temporaryRoot();
      const built = Bun.spawnSync(
        [process.execPath, "build", BOOTSTRAP_ENTRY, "--compile", "--outfile", BOOTSTRAP_BINARY],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(built.exitCode, built.stderr.toString()).toBe(0);

      const finished = Bun.spawnSync([BOOTSTRAP_BINARY], {
        env: { PATH: process.env.PATH ?? "", HOME: root, FALRYN_STATE_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(finished.exitCode, finished.stderr.toString()).toBe(EXIT_CODES.COMPLETED);
      // One file: the compiled close sequence disables persistent WAL and
      // truncates the log exactly as the source-mode one does.
      expect(await readdir(root)).toEqual(["falryn.sqlite"]);

      const opened = openBunSqlite({ path: localPath(`${root}/falryn.sqlite`), create: false });
      if (!opened.ok) {
        throw new Error(`expected a readable database: ${opened.error.code}`);
      }
      const tables = opened.value.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      // The runner's own table plus every product table migration 0001
      // declares. A missing table here is a migration that did not survive
      // `bun build --compile`.
      expect(tables).toEqual([MIGRATION_TABLE, ...PRODUCT_TABLES].sort().map((name) => ({ name })));

      const version = opened.value.all(
        `SELECT COALESCE(MAX(version), 0) AS recordedVersion FROM ${MIGRATION_TABLE}`,
      );
      expect(version).toEqual([{ recordedVersion: PRODUCT_SCHEMA_VERSION }]);
      await opened.value.close();
    },
    COMPILED_BUILD_TIMEOUT_MS,
  );
});

describe.if(!built)("the standalone executable", () => {
  test.skip("was not built, so the compiled path was not checked", () => {
    // Recorded as skipped rather than silently absent: `bun run build` first.
  });
});
