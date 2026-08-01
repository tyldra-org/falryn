/**
 * The record repositories, against a real database.
 *
 * Two things are being checked. First, that a record written through a
 * repository comes back as the same record, under branded identities, with its
 * terminal outcome intact — including the outcomes whose effect certainty the
 * domain leaves implied. Second, that the schema and the repository refuse
 * together: a duplicate identity, a missing parent, a completion with no
 * record, and a row somebody edited by hand each produce a typed answer rather
 * than a driver error a caller would have to interpret.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  invocationRecord,
  modelAttemptRecord,
  sessionRecord,
  turnRecord,
} from "../domain/fixtures.ts";
import {
  createInMemoryEventStore,
  type LocalPath,
  MAX_RECORD_LIST_LIMIT,
  type RecordRepositories,
  type SqliteStorePort,
  sessionId as sessionIdCodec,
  streamId as streamIdCodec,
  type TerminalOutcome,
  turnId as turnIdCodec,
  workspaceId as workspaceIdCodec,
} from "../domain/index.ts";
import {
  temporaryRoot as makeTemporaryRoot,
  openProductStoreOrThrow,
  removeTemporaryRoots,
} from "./fixtures.ts";
import { createRecordRepositories, readSessionView } from "./repositories.ts";

function temporaryRoot(): Promise<LocalPath> {
  return makeTemporaryRoot("falryn-repositories-");
}

afterEach(removeTemporaryRoots);

type Fixture = {
  readonly store: SqliteStorePort;
  readonly repositories: RecordRepositories;
};

async function openRepositories(): Promise<Fixture> {
  const store = await openProductStoreOrThrow(await temporaryRoot());
  return { store, repositories: createRecordRepositories(store) };
}

/** A session with one turn, which is the least a child record needs to exist. */
async function seeded(): Promise<Fixture> {
  const fixture = await openRepositories();
  fixture.repositories.sessions.insert(sessionRecord());
  fixture.repositories.turns.insert(turnRecord());
  return fixture;
}

describe("a session", () => {
  test("round-trips through the repository under its branded identities", async () => {
    const { store, repositories } = await openRepositories();
    const record = sessionRecord();

    expect(repositories.sessions.insert(record)).toEqual({
      ok: true,
      value: { cancelledAfterCommit: false },
    });
    expect(repositories.sessions.get(record.sessionId)).toEqual({ ok: true, value: record });
    await store.close();
  });

  test("is absent rather than an error when it was never written", async () => {
    const { store, repositories } = await openRepositories();

    expect(repositories.sessions.get(sessionIdCodec.from("missing"))).toEqual({
      ok: true,
      value: null,
    });
    await store.close();
  });

  test("refuses a second insert of the same identity", async () => {
    const { store, repositories } = await openRepositories();
    const record = sessionRecord();
    repositories.sessions.insert(record);

    expect(repositories.sessions.insert(record)).toEqual({
      ok: false,
      error: {
        kind: "record",
        code: "already-exists",
        entity: "session",
        identity: record.sessionId,
      },
    });
    await store.close();
  });

  test("closes with its terminal outcome and reads it back", async () => {
    const { store, repositories } = await openRepositories();
    const record = sessionRecord();
    repositories.sessions.insert(record);
    const outcome: TerminalOutcome = { kind: "timed-out", effect: "uncertain" };

    expect(
      repositories.sessions.complete(record.sessionId, {
        completedAt: record.startedAt,
        outcome,
      }).ok,
    ).toBe(true);

    const closed = repositories.sessions.get(record.sessionId);
    expect(closed.ok && closed.value).toMatchObject({ closedAt: record.startedAt, outcome });
    await store.close();
  });

  test("stores completed without inventing an effect field the union lacks", async () => {
    const { store, repositories } = await openRepositories();
    const record = sessionRecord();
    repositories.sessions.insert(record);
    repositories.sessions.complete(record.sessionId, {
      completedAt: record.startedAt,
      outcome: { kind: "completed" },
    });

    const closed = repositories.sessions.get(record.sessionId);
    expect(closed.ok && closed.value?.outcome).toEqual({ kind: "completed" });
    await store.close();
  });

  test("reports not-found when completing a session that was never written", async () => {
    const { store, repositories } = await openRepositories();

    expect(
      repositories.sessions.complete(sessionIdCodec.from("missing"), {
        completedAt: sessionRecord().startedAt,
        outcome: { kind: "completed" },
      }),
    ).toMatchObject({ ok: false, error: { code: "not-found", entity: "session" } });
    await store.close();
  });

  test("lists a workspace's sessions in start order", async () => {
    const { store, repositories } = await openRepositories();
    const workspace = workspaceIdCodec.from("workspace-fixture");
    repositories.sessions.insert(sessionRecord());
    repositories.sessions.insert(
      sessionRecord({
        sessionId: sessionIdCodec.from("session-second"),
        streamId: streamIdCodec.from("session:second"),
      }),
    );

    const listed = repositories.sessions.listByParent(workspace, 10);
    expect(listed.ok && listed.value.map((entry) => entry.sessionId)).toEqual([
      sessionIdCodec.from("session-fixture"),
      sessionIdCodec.from("session-second"),
    ]);
    await store.close();
  });

  test("refuses a listing limit above the declared bound", async () => {
    const { store, repositories } = await openRepositories();

    expect(
      repositories.sessions.listByParent(
        workspaceIdCodec.from("workspace-fixture"),
        MAX_RECORD_LIST_LIMIT + 1,
      ),
    ).toEqual({
      ok: false,
      error: {
        kind: "record",
        code: "invalid-list-limit",
        entity: "session",
        requestedLimit: MAX_RECORD_LIST_LIMIT + 1,
        maximumLimit: MAX_RECORD_LIST_LIMIT,
      },
    });
    await store.close();
  });
});

describe("a turn", () => {
  test("round-trips and lists under its session", async () => {
    const { store, repositories } = await seeded();

    expect(repositories.turns.get(turnRecord().turnId)).toEqual({
      ok: true,
      value: turnRecord(),
    });
    const listed = repositories.turns.listByParent(sessionRecord().sessionId, 10);
    expect(listed.ok && listed.value).toEqual([turnRecord()]);
    await store.close();
  });

  test("cannot be written under a session that does not exist", async () => {
    const { store, repositories } = await openRepositories();

    // The foreign key is what keeps a turn from outliving its session's
    // absence; without it an orphan turn would read as a turn with no history.
    const orphan = repositories.turns.insert(turnRecord());

    expect(orphan).toMatchObject({
      ok: false,
      error: { code: "storage", error: { code: "statement-rejected" } },
    });
    await store.close();
  });

  test("records its fork parent", async () => {
    const { store, repositories } = await seeded();
    const fork = turnRecord({
      turnId: turnIdCodec.from("turn-fork"),
      parentTurnId: turnRecord().turnId,
    });

    expect(repositories.turns.insert(fork).ok).toBe(true);
    expect(repositories.turns.get(fork.turnId)).toEqual({ ok: true, value: fork });
    await store.close();
  });
});

describe("a model attempt and an invocation", () => {
  test("round-trip under their turn", async () => {
    const { store, repositories } = await seeded();
    const attempt = modelAttemptRecord();
    const invocation = invocationRecord();

    expect(repositories.modelAttempts.insert(attempt).ok).toBe(true);
    expect(repositories.invocations.insert(invocation).ok).toBe(true);

    expect(repositories.modelAttempts.get(attempt.modelAttemptId)).toEqual({
      ok: true,
      value: attempt,
    });
    expect(repositories.invocations.get(invocation.invocationId)).toEqual({
      ok: true,
      value: invocation,
    });
    await store.close();
  });

  test("carry effect certainty through their outcome rather than beside it", async () => {
    const { store, repositories } = await seeded();
    const invocation = invocationRecord();
    repositories.invocations.insert(invocation);
    repositories.invocations.complete(invocation.invocationId, {
      completedAt: invocation.startedAt,
      outcome: { kind: "uncertain", effect: "uncertain" },
    });

    const read = repositories.invocations.get(invocation.invocationId);
    expect(read.ok && read.value?.outcome).toEqual({ kind: "uncertain", effect: "uncertain" });
    await store.close();
  });
});

describe("a hand-edited row", () => {
  test("is rejected on read with a path and no rejected value", async () => {
    const { store, repositories } = await seeded();
    // A timestamp is a shape SQLite has no type for, so this is exactly the
    // class of damage only the parser can catch.
    store.write((statements) => statements.run("UPDATE sessions SET started_at = 'yesterday'"));

    expect(repositories.sessions.get(sessionRecord().sessionId)).toEqual({
      ok: false,
      error: {
        kind: "record",
        code: "malformed-row",
        entity: "session",
        issues: [{ path: "startedAt", code: "custom" }],
      },
    });
    await store.close();
  });

  test("is rejected by the schema when it violates a declared constraint", async () => {
    const { store } = await seeded();

    const written = store.write((statements) =>
      statements.run("UPDATE turns SET outcome_kind = 'abandoned', outcome_effect = 'none'"),
    );

    expect(written).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });

  test("cannot leave a record half-terminal", async () => {
    const { store } = await seeded();

    // A completion time with no outcome, or an outcome with no time, would be a
    // record whose lifecycle two columns disagree about.
    const written = store.write((statements) =>
      statements.run("UPDATE turns SET completed_at = '2026-07-31T12:00:00.000Z'"),
    );

    expect(written).toMatchObject({ ok: false, error: { code: "statement-rejected" } });
    await store.close();
  });
});

describe("the session view", () => {
  test("gathers a session, its turns, and its events into one shape", async () => {
    const { store, repositories } = await seeded();
    repositories.modelAttempts.insert(modelAttemptRecord());
    repositories.invocations.insert(invocationRecord());

    const view = await readSessionView(
      repositories,
      createInMemoryEventStore(),
      sessionRecord().sessionId,
    );

    expect(view.ok && view.value).toMatchObject({
      session: sessionRecord(),
      turns: [
        {
          turn: turnRecord(),
          modelAttempts: [modelAttemptRecord()],
          invocations: [invocationRecord()],
        },
      ],
      events: [],
      truncated: false,
    });
    await store.close();
  });

  test("is absent rather than empty when the session was never written", async () => {
    const { store, repositories } = await openRepositories();

    const view = await readSessionView(
      repositories,
      createInMemoryEventStore(),
      sessionIdCodec.from("missing"),
    );

    expect(view).toEqual({ ok: true, value: null });
    await store.close();
  });

  test("says so when a bound stopped it short", async () => {
    const { store, repositories } = await seeded();

    const view = await readSessionView(
      repositories,
      createInMemoryEventStore(),
      sessionRecord().sessionId,
      { turns: 1, perTurn: 10, events: 10 },
    );

    expect(view.ok && view.value?.truncated).toBe(true);
    await store.close();
  });
});
