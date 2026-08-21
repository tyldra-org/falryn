/**
 * The `falryn session` command surface against a real temporary local-data tree.
 *
 * Catalog, isolation, and redaction stay in the owning services. These tests
 * prove the CLI declares list/show, bounds a long list, reports failures as
 * observed, and never prints secret-shaped text.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REDACTED } from "../application/index.ts";
import { createSqliteEventStore } from "../data/event-store.ts";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../data/fixtures.ts";
import { createRecordRepositories } from "../data/repositories.ts";
import { sessionStarted } from "../domain/fixtures.ts";
import {
  createStaticEnvironment,
  localPath,
  type SessionId,
  sessionId,
  streamId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { parseInvocation } from "./command-tree.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider } from "./services.ts";
import { createRecordingCliStreams } from "./streams.ts";

afterEach(removeTemporaryRoots);

const SECRET = "apiKey=hunter2";
const BOUND = workspaceId.from("cli");
const KEEP: SessionId = sessionId.from("keep");
const FOREIGN: SessionId = sessionId.from("foreign");

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function seededHome(options: {
  readonly titles?: readonly string[];
  readonly includeForeign?: boolean;
  readonly corrupt?: boolean;
  readonly futureSchema?: boolean;
  readonly withTurnAndEvents?: boolean;
}): Promise<{
  readonly home: string;
  readonly state: string;
  readonly environment: ReturnType<typeof createStaticEnvironment>;
}> {
  const home = await mkdtemp(join(tmpdir(), "falryn-session-cli-"));
  homes.push(home);
  const state = join(home, "state");
  const artifacts = join(home, "artifacts");
  const temp = join(home, "tmp");
  const config = join(home, "config");
  const exportsDir = join(home, "exports");
  await mkdir(state, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await mkdir(temp, { recursive: true });
  await mkdir(config, { recursive: true });
  await mkdir(exportsDir, { recursive: true });
  for (const directory of [home, state, exportsDir, artifacts, temp, config]) {
    await chmod(directory, 0o700);
  }

  const store = await openProductStoreOrThrow(localPath(state));
  store.write((statements) => {
    statements.run(
      `INSERT INTO runs (run_id, started_at, ended_at, schema_version)
       VALUES ($runId, '2026-07-31T12:00:00.000Z', NULL, 3)`,
      { runId: "run-session-cli" },
    );
  });
  const repositories = createRecordRepositories(store);
  const titles = options.titles ?? ["Keep"];
  for (const [index, title] of titles.entries()) {
    const inserted = repositories.sessions.insert({
      sessionId: index === 0 ? KEEP : sessionId.from(`s${index}`),
      workspaceId: BOUND,
      streamId: streamId.from(`stream-${index}`),
      title,
      configurationGeneration: 0 as never,
      startedAt: `2026-07-31T12:00:${String(index).padStart(2, "0")}.000Z` as never,
      closedAt: null,
      outcome: null,
    });
    if (!inserted.ok) {
      throw new Error("expected the session to insert");
    }
  }
  if (options.withTurnAndEvents === true) {
    const turn = repositories.turns.insert({
      turnId: turnId.from("turn-1"),
      sessionId: KEEP,
      parentTurnId: null,
      startedAt: "2026-07-31T12:00:00.000Z" as never,
      completedAt: null,
      outcome: null,
    });
    if (!turn.ok) {
      throw new Error("expected the turn to insert");
    }
    const events = createSqliteEventStore(store);
    const started = sessionStarted(1);
    const withStream = {
      ...started,
      streamId: streamId.from("stream-0"),
    };
    const appended = await events.append(withStream);
    if (!appended.ok) {
      throw new Error("expected the event to append");
    }
  }
  if (options.includeForeign === true) {
    const inserted = repositories.sessions.insert({
      sessionId: FOREIGN,
      workspaceId: workspaceId.from("other-ws"),
      streamId: streamId.from("stream-foreign"),
      title: "Foreign",
      configurationGeneration: 0 as never,
      startedAt: "2026-07-31T12:00:59.000Z" as never,
      closedAt: null,
      outcome: null,
    });
    if (!inserted.ok) {
      throw new Error("expected the foreign session to insert");
    }
  }
  if (options.corrupt === true) {
    store.write((statements) => {
      statements.run(
        `INSERT INTO sessions (
           session_id, workspace_id, stream_id, title, configuration_generation,
           started_at, closed_at, outcome_kind, outcome_effect
         ) VALUES ('bad', 'cli', 'stream-bad', 'Broken', 0, 'not-a-timestamp', NULL, NULL, NULL)`,
      );
    });
  }
  if (options.futureSchema === true) {
    store.write((statements) => {
      statements.run(
        `INSERT INTO falryn_schema_migrations (version, name, checksum, applied_at)
         VALUES (9999, 'future', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                 1753963200000)`,
      );
    });
  }
  await store.close();

  return {
    home,
    state,
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

describe("session command parsing", () => {
  test("routes list and show", async () => {
    const listed = await parseInvocation(["session", "list"]);
    expect(listed.kind).toBe("run");
    if (listed.kind === "run") {
      expect(listed.command).toBe("session.list");
      expect(listed.sessionArgs?.action).toBe("list");
    }
    const shown = await parseInvocation(["session", "show", "keep"]);
    expect(shown.kind).toBe("run");
    if (shown.kind === "run") {
      expect(shown.command).toBe("session.show");
      expect(shown.sessionArgs?.action).toBe("show");
    }
  });

  test("routes resume, fork, rewind, and replay", async () => {
    const resumed = await parseInvocation(["session", "resume", "keep"]);
    expect(resumed.kind).toBe("run");
    if (resumed.kind === "run") {
      expect(resumed.command).toBe("session.resume");
    }
    const forked = await parseInvocation(["session", "fork", "keep"]);
    expect(forked.kind).toBe("run");
    if (forked.kind === "run") {
      expect(forked.command).toBe("session.fork");
    }
    const rewound = await parseInvocation(["session", "rewind", "keep", "--at-turn", "turn-1"]);
    expect(rewound.kind).toBe("run");
    if (rewound.kind === "run") {
      expect(rewound.command).toBe("session.rewind");
      expect(rewound.sessionArgs).toMatchObject({ action: "rewind", atTurnId: "turn-1" });
    }
    const replayed = await parseInvocation(["session", "replay", "keep"]);
    expect(replayed.kind).toBe("run");
    if (replayed.kind === "run") {
      expect(replayed.command).toBe("session.replay");
    }
  });

  test("requires an identity for show", async () => {
    const missing = await parseInvocation(["session", "show"]);
    expect(missing.kind).toBe("invalid");
  });

  test("requires at-turn for rewind", async () => {
    const missing = await parseInvocation(["session", "rewind", "keep"]);
    expect(missing.kind).toBe("invalid");
  });
});

describe("session command behavior", () => {
  test("lists an empty catalog when no database exists yet", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-session-empty-"));
    homes.push(home);
    const state = join(home, "state");
    await mkdir(state, { recursive: true });
    await chmod(home, 0o700);
    await chmod(state, 0o700);
    const seeded = {
      home,
      state,
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: state }),
    };
    const result = await run(["session", "list"], seeded);
    expect(result.code).toBe(EXIT_CODES.COMPLETED);
    expect(result.out).toContain("No sessions.");
  });

  test("lists bound sessions and omits a foreign workspace", async () => {
    const seeded = await seededHome({ includeForeign: true });
    const listed = await run(["session", "list"], seeded);
    expect(listed.code).toBe(EXIT_CODES.COMPLETED);
    expect(listed.out).toContain("keep");
    expect(listed.out).not.toContain("foreign");
    const shown = await run(["session", "show", "foreign"], seeded);
    expect(shown.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(shown.out).not.toContain("Foreign");
  });

  test("bounds a long list and names an expansion this build honours", async () => {
    const seeded = await seededHome({
      titles: ["Keep", "Two", "Three"],
    });
    const listed = await run(["session", "list", "--limit", "2"], seeded);
    expect(listed.code).toBe(EXIT_CODES.COMPLETED);
    expect(listed.err).toContain("2 of 3");
    expect(listed.err).toContain("falryn session list");
    expect(listed.err).toContain("--limit 256");
    const expanded = await run(["session", "list", "--limit", "256"], seeded);
    expect(expanded.code).toBe(EXIT_CODES.COMPLETED);
    expect(expanded.out).toContain("s1");
    expect(expanded.out).toContain("s2");
    expect(expanded.err).not.toContain("of 3");
  });

  test("redacts a secret-shaped title in every format", async () => {
    const seeded = await seededHome({ titles: [SECRET] });
    for (const format of ["human", "quiet", "json", "jsonl"] as const) {
      const listed = await run(["session", "list", "--format", format], seeded);
      expect(`${listed.out}${listed.err}`).not.toContain(SECRET);
      const shown = await run(["session", "show", "keep", "--format", format], seeded);
      expect(`${shown.out}${shown.err}`).not.toContain(SECRET);
      if (format !== "quiet") {
        expect(`${listed.out}${listed.err}`).toContain(REDACTED);
      }
    }
  });

  test("reports a corrupt session as observed, not as an empty success", async () => {
    const seeded = await seededHome({ corrupt: true });
    const listed = await run(["session", "list"], seeded);
    expect(listed.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(listed.out).not.toBe("No sessions.\n");
    expect(listed.err.length).toBeGreaterThan(0);
  });

  test("reports a newer schema as observed, not as an empty success", async () => {
    const seeded = await seededHome({ futureSchema: true });
    const listed = await run(["session", "list"], seeded);
    expect(listed.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(listed.err).toMatch(/schema|newer|read/i);
  });

  test("reports a missing session as observed, not as an empty success", async () => {
    const seeded = await seededHome({});
    const shown = await run(["session", "show", "missing"], seeded);
    expect(shown.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(shown.out).not.toContain("Identity");
  });

  test("resumes, forks, rewinds, and replays without repeating effects", async () => {
    const seeded = await seededHome({ withTurnAndEvents: true });
    const resumed = await run(["session", "resume", "keep"], seeded);
    expect(resumed.code).toBe(EXIT_CODES.COMPLETED);
    expect(resumed.out).toContain("Session resume");
    expect(resumed.out).toContain("keep");

    const forked = await run(
      [
        "session",
        "fork",
        "keep",
        "--new-session-id",
        "forked-keep",
        "--new-stream-id",
        "stream-forked-keep",
      ],
      seeded,
    );
    expect(forked.code).toBe(EXIT_CODES.COMPLETED);
    expect(forked.out).toContain("Session fork");
    expect(forked.out).toContain("forked-keep");

    const rewound = await run(
      [
        "session",
        "rewind",
        "keep",
        "--at-turn",
        "turn-1",
        "--new-session-id",
        "rewound-keep",
        "--new-stream-id",
        "stream-rewound-keep",
      ],
      seeded,
    );
    expect(rewound.code).toBe(EXIT_CODES.COMPLETED);
    expect(rewound.out).toContain("Session rewind");
    expect(rewound.out).toContain("turn-1");

    const replayed = await run(["session", "replay", "keep"], seeded);
    expect(replayed.code).toBe(EXIT_CODES.COMPLETED);
    expect(replayed.out).toContain("effect-free");
    expect(replayed.out).toContain("playing");
  });

  test("fails closed when resume targets a missing session", async () => {
    const seeded = await seededHome({});
    const resumed = await run(["session", "resume", "missing"], seeded);
    expect(resumed.code).not.toBe(EXIT_CODES.COMPLETED);
    expect(resumed.err.length).toBeGreaterThan(0);
  });
});
