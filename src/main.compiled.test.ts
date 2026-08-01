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
import { MIGRATION_TABLE } from "./data/index.ts";
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
 * Generous because the process currently lingers for one full shutdown phase
 * grace after its work is done — an uncleared phase timer in the lifecycle
 * owner, unrelated to storage, tracked as falryn#316. The check is about what
 * the executable produces, not how fast it exits.
 */
const COMPILED_RUN_TIMEOUT_MS = 30_000;

function runCompiled(root: LocalPath): number {
  // Synchronous on purpose: the child writes nothing, and an asynchronous spawn
  // whose pipes nobody drains can block on a full buffer rather than exiting.
  const finished = Bun.spawnSync([EXECUTABLE], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      FALRYN_STATE_DIR: root,
    },
  });
  return finished.exitCode;
}

describe.if(built)("the standalone executable", () => {
  test(
    "opens, migrates, and closes against a temporary state root",
    async () => {
      const root = await temporaryRoot();

      expect(runCompiled(root)).toBe(0);
      // One file: the compiled close sequence disables persistent WAL and
      // truncates the log exactly as the source-mode one does.
      expect(await readdir(root)).toEqual(["falryn.sqlite"]);
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "carries its migration bookkeeping into the compiled binary",
    async () => {
      const root = await temporaryRoot();
      runCompiled(root);

      const opened = openBunSqlite({ path: localPath(`${root}/falryn.sqlite`), create: false });
      if (!opened.ok) {
        throw new Error(`expected a readable database: ${opened.error.code}`);
      }
      const tables = opened.value.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      // The v0.1 production set is empty, so the runner's own table is the whole
      // schema — and its presence proves the runner ran rather than being
      // optimized away.
      expect(tables).toEqual([{ name: MIGRATION_TABLE }]);
      await opened.value.close();
    },
    COMPILED_RUN_TIMEOUT_MS,
  );

  test(
    "reopens the same database on a second run",
    async () => {
      const root = await temporaryRoot();

      expect(runCompiled(root)).toBe(0);
      expect(runCompiled(root)).toBe(0);
      expect(await readdir(root)).toEqual(["falryn.sqlite"]);
    },
    COMPILED_RUN_TIMEOUT_MS,
  );
});

describe.if(!built)("the standalone executable", () => {
  test.skip("was not built, so the compiled path was not checked", () => {
    // Recorded as skipped rather than silently absent: `bun run build` first.
  });
});
