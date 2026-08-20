/**
 * The `falryn export` command surface against a real temporary local-data tree.
 *
 * Selection, redaction, and package layout stay in the data layer. These tests
 * prove the CLI declares the command, previews before write, returns a handle,
 * refuses destination failures, and never prints secret-shaped text.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REDACTED } from "../application/index.ts";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../data/fixtures.ts";
import { createRecordRepositories } from "../data/repositories.ts";
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
import { runExport } from "./commands.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

afterEach(removeTemporaryRoots);

const SECRET = "apiKey=hunter2";
const SESSION: SessionId = sessionId.from("s1");

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function seededHome(title: string | null = null): Promise<{
  readonly home: string;
  readonly state: string;
  readonly exports: string;
  readonly environment: ReturnType<typeof createStaticEnvironment>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-export-cli-"));
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
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, 3)`,
      { runId: "run-export-cli" },
    );
  });
  const repositories = createRecordRepositories(store);
  const inserted = repositories.sessions.insert({
    sessionId: SESSION,
    workspaceId: "w" as never,
    streamId: "stream-s1" as never,
    title,
    configurationGeneration: 0 as never,
    startedAt: "2026-07-31T12:00:00.000Z" as never,
    closedAt: null,
    outcome: null,
  });
  if (!inserted.ok) {
    throw new Error("expected the session to insert");
  }
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

describe("export command parsing", () => {
  test("routes preview and write invocations", async () => {
    const preview = await parseInvocation(["export", "--session", "s1"]);
    expect(preview.kind).toBe("run");
    if (preview.kind === "run") {
      expect(preview.command).toBe("export");
      expect(preview.exportArgs?.write).toBe(false);
      expect(preview.exportArgs?.selection.kind).toBe("sessions");
    }

    const written = await parseInvocation([
      "export",
      "--session",
      "s1",
      "--write",
      "--name",
      "bundle-1",
    ]);
    expect(written.kind).toBe("run");
    if (written.kind === "run") {
      expect(written.exportArgs?.write).toBe(true);
      expect(written.exportArgs?.name).toEqual(exportName.from("bundle-1"));
    }
  });

  test("refuses incomplete or conflicting selection flags", async () => {
    const bare = await parseInvocation(["export"]);
    expect(bare.kind).toBe("invalid");

    const writeOnly = await parseInvocation(["export", "--session", "s1", "--write"]);
    expect(writeOnly.kind).toBe("invalid");

    const mixed = await parseInvocation([
      "export",
      "--session",
      "s1",
      "--after",
      "2026-07-31T12:00:00.000Z",
    ]);
    expect(mixed.kind).toBe("invalid");
  });
});

describe("export command behavior", () => {
  test("previews selection counts without writing a package", async () => {
    const seeded = await seededHome();
    const result = await run(["export", "--session", "s1"], seeded);

    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.out).toContain("Export preview");
    expect(result.out).toContain("s1");
    expect(result.err).toContain("Preview only");
    expect(await readdir(seeded.exports)).toEqual([]);
  });

  test("writes a package and reports a handle, never the records body", async () => {
    const seeded = await seededHome();
    const result = await run(
      ["export", "--session", "s1", "--write", "--name", "bundle-1"],
      seeded,
    );

    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.out).toContain("Export written");
    expect(result.out).toContain("bundle-1");
    expect(result.out).toContain(seeded.exports);
    expect(result.out).not.toContain("records.jsonl");
    expect(await readdir(seeded.exports)).toContain("bundle-1");
  });

  test("keeps secret-shaped text off stdout, stderr, and the written package", async () => {
    const seeded = await seededHome(SECRET);
    const result = await run(
      ["export", "--session", "s1", "--write", "--name", "redacted"],
      seeded,
    );

    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.out).not.toContain("hunter2");
    expect(result.err).not.toContain("hunter2");
    const bytes = await readFile(join(seeded.exports, "redacted"), "utf8");
    expect(bytes).not.toContain("hunter2");
    expect(bytes).toContain(`apiKey=${REDACTED}`);
  });

  test("refuses a missing session rather than writing an empty package", async () => {
    const seeded = await seededHome();
    const result = await run(["export", "--session", "missing"], seeded);
    expect(result.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(result.err.toLowerCase()).toContain("not found");
    expect(await readdir(seeded.exports)).toEqual([]);
  });

  test("refuses an unwritable exports destination", async () => {
    const seeded = await seededHome();
    await chmod(seeded.exports, 0o555);
    try {
      const result = await run(
        ["export", "--session", "s1", "--write", "--name", "blocked"],
        seeded,
      );
      expect(result.code).not.toBe(EXIT_CODES.COMPLETED);
      expect(await readdir(seeded.exports)).toEqual([]);
    } finally {
      await chmod(seeded.exports, 0o755);
    }
  });

  test("an already-aborted signal is not a clean completed write", async () => {
    const seeded = await seededHome();
    const services = providerFor(seeded)({
      format: "human",
      color: "auto",
      quiet: false,
      verbose: false,
      nonInteractive: false,
      workspace: null,
      addDirs: [],
      profile: null,
      timeoutMs: null,
      help: false,
      version: false,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await runExport(
      services,
      {
        selection: { kind: "sessions", sessionIds: [SESSION], includeSensitive: false },
        write: true,
        name: exportName.from("interrupted"),
      },
      controller.signal,
    );
    expect(result.outcome.kind).not.toBe("completed");
    expect(await readdir(seeded.exports)).toEqual([]);
  });
});
