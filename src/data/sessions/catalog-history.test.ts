import { afterEach, expect, test } from "bun:test";
import { rewindWorkspaceSession } from "../../application/sessions/session-rewind.ts";
import { CATALOG_HISTORY_BYTES } from "../../domain/extensions/catalog-history.ts";
import { sessionRecord, sessionStarted } from "../../domain/fixtures.ts";
import { sessionId, streamId, workspaceId } from "../../domain/foundation/index.ts";
import { decodeRuntimeEvent, parseSessionRecord } from "../../domain/sessions/index.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { sessionCatalogHistoryFixture } from "./catalog-history-fixtures.ts";
import { createSqliteEventStore } from "./event-store.ts";
import { createRecordRepositories } from "./repositories.ts";

afterEach(removeTemporaryRoots);

test("legacy absence and malformed historical schema remain distinct", () => {
  expect(parseSessionRecord(sessionRecord())).toEqual({ ok: true, value: sessionRecord() });
  const history = sessionCatalogHistoryFixture();
  const oversized = {
    ...history,
    entries: Array.from({ length: 32 }, () => ({
      ...history.entries[0],
      reason: "界".repeat(256),
    })),
    total: 32,
  };
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(CATALOG_HISTORY_BYTES);
  for (const extensionCatalog of [
    oversized,
    null,
    {},
    { ...sessionCatalogHistoryFixture(), kind: "live" },
    { ...sessionCatalogHistoryFixture(), total: 99 },
    {
      ...sessionCatalogHistoryFixture(),
      entries: Array(33).fill(sessionCatalogHistoryFixture().entries[0]),
    },
  ]) {
    expect(parseSessionRecord({ ...sessionRecord(), extensionCatalog }).ok).toBe(false);
    expect(
      decodeRuntimeEvent(JSON.stringify({ ...sessionStarted(1), payload: { extensionCatalog } }))
        .ok,
    ).toBe(false);
  }
});

test("stored JSON rejects malformed, oversized and wrong-type rows without throwing", async () => {
  const store = await openProductStoreOrThrow(await temporaryRoot("falryn-history-corrupt-"));
  try {
    const repositories = createRecordRepositories(store);
    const record = sessionRecord();
    expect(repositories.sessions.insert(record).ok).toBe(true);
    expect(repositories.sessions.get(record.sessionId)).toEqual({ ok: true, value: record });
    for (const text of [
      "{",
      "null",
      "{}",
      " ".repeat(CATALOG_HISTORY_BYTES + 1),
      JSON.stringify(sessionCatalogHistoryFixture()) + " ".repeat(CATALOG_HISTORY_BYTES),
    ]) {
      expect(
        store.write((sql) => sql.run("UPDATE sessions SET extension_catalog = $text", { text })).ok,
      ).toBe(true);
      const read = repositories.sessions.get(record.sessionId);
      expect(read).toMatchObject({ ok: false, error: { code: "malformed-row" } });
      if (!read.ok && read.error.code === "malformed-row") {
        expect(read.error.issues.every((issue) => issue.path.startsWith("extensionCatalog"))).toBe(
          true,
        );
      }
      expect(repositories.sessions.listByParent(record.workspaceId, 1).ok).toBe(false);
    }
  } finally {
    await store.close();
  }
});

test("started event and historical record commit together, survive reopen and application fork", async () => {
  const root = await temporaryRoot("falryn-history-reopen-");
  const history = sessionCatalogHistoryFixture();
  const event = { ...sessionStarted(1), payload: { extensionCatalog: history } };
  const store = await openProductStoreOrThrow(root);
  try {
    const events = createSqliteEventStore(store, { projectStartedRecords: true });
    expect((await events.append(event)).ok).toBe(true);
    expect(createRecordRepositories(store).sessions.get(event.correlation.sessionId)).toMatchObject(
      {
        ok: true,
        value: { extensionCatalog: history },
      },
    );
  } finally {
    await store.close();
  }
  const reopened = await openProductStoreOrThrow(root);
  try {
    const repositories = createRecordRepositories(reopened);
    expect(repositories.sessions.get(event.correlation.sessionId)).toMatchObject({
      ok: true,
      value: { extensionCatalog: history },
    });
    expect(
      await createSqliteEventStore(reopened).readFrom(
        { streamId: event.streamId, afterSequence: null },
        10,
      ),
    ).toEqual({ ok: true, value: [event] });
    const target = sessionId.from("fork-history");
    expect(
      rewindWorkspaceSession(repositories.sessions, repositories.turns, {
        sourceSessionId: event.correlation.sessionId,
        identities: {
          sessionId: target,
          streamId: streamId.from("fork-stream"),
          workspaceId: workspaceId.from("different-workspace"),
        },
        edit: { kind: "fork" },
      }).ok,
    ).toBe(true);
    const fork = repositories.sessions.get(target);
    expect(fork.ok && fork.value?.extensionCatalog).toEqual(history);
    expect(reopened.read("SELECT * FROM extension_scope_controls")).toEqual({
      ok: true,
      value: [],
    });
    expect(history.entries[0]).not.toHaveProperty("binding");
  } finally {
    await reopened.close();
  }
});

test("failed event insertion rolls back the historical start projection", async () => {
  const store = await openProductStoreOrThrow(await temporaryRoot("falryn-history-atomic-"));
  try {
    expect(
      store.write((sql) =>
        sql.run(
          "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'test'); END",
        ),
      ).ok,
    ).toBe(true);
    const event = {
      ...sessionStarted(1),
      payload: { extensionCatalog: sessionCatalogHistoryFixture() },
    };
    expect(
      (await createSqliteEventStore(store, { projectStartedRecords: true }).append(event)).ok,
    ).toBe(false);
    expect(createRecordRepositories(store).sessions.get(event.correlation.sessionId)).toEqual({
      ok: true,
      value: null,
    });
    expect(store.read("SELECT event_id FROM events")).toEqual({ ok: true, value: [] });
  } finally {
    await store.close();
  }
});
