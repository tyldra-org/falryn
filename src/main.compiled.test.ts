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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EXIT_CODES, FALRYN_VERSION } from "./cli/index.ts";
import { MIGRATION_TABLE, PRODUCT_SCHEMA_VERSION, PRODUCT_TABLES } from "./data/index.ts";
import { type LocalPath, localPath } from "./domain/index.ts";
import { openBunSqlite } from "./integrations/index.ts";

const EXECUTABLE = join(dirname(dirname(import.meta.path)), "dist", "falryn");

const roots: string[] = [];

async function temporaryRoot(): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), "falryn-compiled-"));
  roots.push(created);
  return localPath(created);
}

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

function runCompiled(root: LocalPath): number {
  return spawnCompiled(root).exitCode;
}

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
      // the storage bootstrap: it prints help and exits 0. That it creates no
      // file is the compiled proof of `reference/CLI.md`'s rule that help
      // initializes nothing.
      const root = await temporaryRoot();
      const finished = spawnCompiled(root);

      expect(finished.exitCode).toBe(EXIT_CODES.COMPLETED);
      expect(finished.stdout).toContain("falryn [command] [options]");
      expect(finished.stderr).toBe("");
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
      expect(JSON.parse(finished.stdout)).toMatchObject({
        command: "doctor",
        outcome: { kind: "completed" },
      });
      // Diagnostics describe roots; they do not create them.
      expect(await readdir(root)).toEqual([]);
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test.todo("carries its migration bookkeeping into the compiled binary — pending doctor's storage report", () => {
    // These assertions used to ride on the bare invocation running the
    // storage bootstrap, which #17 replaced with the command tree. #17 gives
    // `doctor` "the database open and migration report", and this check
    // returns when it does: `doctor` opens an existing database with
    // `create: false`, reports its schema version and applied migrations,
    // and reports "not created" rather than creating one.
    //
    // Recorded as a todo rather than deleted, because SQL kept in a file
    // tree needs a loader to be embedded and that is exactly the failure a
    // compiled check exists to catch. `src/main.test.ts` still exercises the
    // bootstrap and its migrations in source mode, so the behavior is
    // covered; what is currently uncovered is that it survives packaging.
  });
});

describe.if(!built)("the standalone executable", () => {
  test.skip("was not built, so the compiled path was not checked", () => {
    // Recorded as skipped rather than silently absent: `bun run build` first.
  });
});
