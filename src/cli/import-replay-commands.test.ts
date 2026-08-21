/**
 * The `falryn import` and `falryn replay` command surface against real temp trees.
 *
 * Verification failures fail closed. Import applies a package; replay rebuilds
 * from stored facts without repeating effects. This is not `session replay`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteEventStore } from "../data/event-store.ts";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../data/fixtures.ts";
import { createRecordRepositories } from "../data/repositories.ts";
import { sessionStarted } from "../domain/fixtures.ts";
import {
  createStaticEnvironment,
  exportName,
  invocationId,
  localPath,
  type SessionId,
  sessionId,
  turnId,
} from "../domain/index.ts";
import { parseInvocation } from "./command-tree.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

afterEach(removeTemporaryRoots);

const SESSION: SessionId = sessionId.from("s1");
const PACKAGE = exportName.from("bundle-import");

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function seededHome(): Promise<{
  readonly home: string;
  readonly state: string;
  readonly exports: string;
  readonly environment: ReturnType<typeof createStaticEnvironment>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-import-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const exportsDir = join(home, "exports");
  const artifacts = join(home, "artifacts");
  const temp = join(home, "tmp");
  const config = join(home, "config");
  await mkdir(state, { recursive: true });
  await mkdir(exportsDir, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await mkdir(temp, { recursive: true });
  await mkdir(config, { recursive: true });
  for (const directory of [home, state, exportsDir, artifacts, temp, config]) {
    await chmod(directory, 0o700);
  }

  const store = await openProductStoreOrThrow(localPath(state));
  store.write((statements) => {
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, 4)`,
      { runId: "run-export-cli" },
    );
  });
  const repositories = createRecordRepositories(store);
  repositories.sessions.insert({
    sessionId: SESSION,
    workspaceId: "w" as never,
    streamId: "stream-s1" as never,
    title: null,
    configurationGeneration: 0 as never,
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    closedAt: null,
    outcome: null,
  });
  repositories.turns.insert({
    turnId: turnId.from("t-s1"),
    sessionId: SESSION,
    parentTurnId: null,
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    completedAt: null,
    outcome: null,
  });
  repositories.invocations.insert({
    invocationId: invocationId.from("inv-1"),
    turnId: turnId.from("t-s1"),
    capabilityId: "read" as never,
    capabilityVersion: 1,
    inputDigest: "ab",
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    completedAt: null,
    outcome: null,
  });
  const events = createSqliteEventStore(store);
  await events.append({
    ...sessionStarted(1),
    streamId: "stream-s1" as never,
  });
  await store.close();

  return {
    home,
    state,
    exports: exportsDir,
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: state,
      FALRYN_EXPORT_DIR: exportsDir,
      FALRYN_ARTIFACT_DIR: artifacts,
      FALRYN_TEMP_DIR: temp,
      FALRYN_CONFIG_DIR: config,
    }),
  };
}

function providerFor(seeded: Awaited<ReturnType<typeof seededHome>>) {
  return (globals: GlobalOptions) =>
    createServiceProvider(globals, {
      home: localPath(seeded.home),
      platform: "darwin",
      environment: seeded.environment,
    });
}

async function run(argv: readonly string[], seeded: Awaited<ReturnType<typeof seededHome>>) {
  const streams = createRecordingCliStreams();
  const code = await dispatch({
    argv,
    streams,
    services: providerFor(seeded),
  });
  return {
    code,
    out: streams.resultWrites().join(""),
    err: streams.diagnosticWrites().join(""),
  };
}

async function resetStateDatabase(stateDir: string): Promise<void> {
  for (const file of ["falryn.sqlite", "falryn.sqlite-wal", "falryn.sqlite-shm"]) {
    await rm(join(stateDir, file), { force: true });
  }
  const store = await openProductStoreOrThrow(localPath(stateDir));
  await store.close();
}

describe("import and replay command parsing", () => {
  test("routes import and replay invocations", async () => {
    const imported = await parseInvocation(["import", "bundle-1"]);
    expect(imported.kind).toBe("run");
    if (imported.kind === "run") {
      expect(imported.command).toBe("import");
      expect(imported.importArgs?.name).toEqual(exportName.from("bundle-1"));
    }

    const replayed = await parseInvocation(["replay", "s1"]);
    expect(replayed.kind).toBe("run");
    if (replayed.kind === "run") {
      expect(replayed.command).toBe("replay");
      expect(replayed.replayArgs?.sessionId).toBe(SESSION);
    }
  });

  test("refuses export flags on import and session replay controls on replay", async () => {
    const bare = await parseInvocation(["import"]);
    expect(bare.kind).toBe("invalid");

    const exportFlags = await parseInvocation(["import", "bundle-1", "--write"]);
    expect(exportFlags.kind).toBe("invalid");

    const cursor = await parseInvocation(["replay", "s1", "--replay-action", "seek"]);
    expect(cursor.kind).toBe("invalid");
  });
});

describe("import and replay command behavior", () => {
  test("imports a verified package and replays it without repeating effects", async () => {
    const seeded = await seededHome();
    const exported = await run(["export", "--session", "s1", "--write", "--name", PACKAGE], seeded);
    expect(exported.code).toBe(EXIT_CODES.COMPLETED);
    expect(await readdir(seeded.exports)).toContain(PACKAGE);

    await resetStateDatabase(seeded.state);

    const imported = await run(["import", PACKAGE], seeded);
    expect(imported.code).toBe(EXIT_CODES.COMPLETED);
    expect(imported.out).toContain("Import completed");
    expect(imported.out).toContain("s1");

    const replayed = await run(["replay", "s1"], seeded);
    expect(replayed.code).toBe(EXIT_CODES.COMPLETED);
    expect(replayed.out).toContain("Replay rebuild (effect-free)");
    expect(replayed.out).toContain("stream-s1");
    expect(replayed.err).toContain("session replay");
  });

  test("refuses a tampered package before any session is inserted", async () => {
    const seeded = await seededHome();
    const exported = await run(["export", "--session", "s1", "--write", "--name", PACKAGE], seeded);
    expect(exported.code).toBe(EXIT_CODES.COMPLETED);

    await resetStateDatabase(seeded.state);

    const path = join(seeded.exports, PACKAGE);
    const bytes = new Uint8Array(await readFile(path));
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 0xff;
    await writeFile(path, bytes);

    const imported = await run(["import", PACKAGE], seeded);
    expect(imported.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(imported.err.toLowerCase()).toMatch(/verif|manifest|digest|malformed|integrity/);

    const replayed = await run(["replay", "s1"], seeded);
    expect(replayed.code).not.toBe(EXIT_CODES.COMPLETED);
  });

  test("refuses a second import when identities collide", async () => {
    const seeded = await seededHome();
    const exported = await run(["export", "--session", "s1", "--write", "--name", PACKAGE], seeded);
    expect(exported.code).toBe(EXIT_CODES.COMPLETED);

    await resetStateDatabase(seeded.state);

    const first = await run(["import", PACKAGE], seeded);
    expect(first.code).toBe(EXIT_CODES.COMPLETED);

    const again = await run(["import", PACKAGE], seeded);
    expect(again.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(again.err.toLowerCase()).toContain("identity");
  });
});
