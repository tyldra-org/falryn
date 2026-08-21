import { describe, expect, test } from "bun:test";
import { sessionRecord, sessionStarted, turnRecord, turnStarted } from "../../domain/fixtures.ts";
import {
  createInMemoryEventStore,
  err,
  ok,
  type RecordError,
  type RecordWrite,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  type TurnId,
  type TurnRecord,
  type TurnRepositoryPort,
  type WorkspaceId,
} from "../../domain/index.ts";
import {
  createSessionNavigationController,
  noticeForReplay,
  noticeForResume,
} from "./controller.ts";

function memorySessions(records: SessionRecord[]): SessionRepositoryPort {
  return {
    insert(record: SessionRecord) {
      if (records.some((item) => item.sessionId === record.sessionId)) {
        const error: RecordError = {
          kind: "record",
          code: "already-exists",
          entity: "session",
          identity: record.sessionId,
        };
        return err(error);
      }
      records.push(record);
      const write: RecordWrite = { cancelledAfterCommit: false };
      return ok(write);
    },
    complete() {
      return ok({ cancelledAfterCommit: false });
    },
    get(id: SessionId) {
      return ok(records.find((record) => record.sessionId === id) ?? null);
    },
    listByParent(parentId: WorkspaceId, _limit: number) {
      return ok(records.filter((record) => record.workspaceId === parentId));
    },
  };
}

function memoryTurns(records: readonly TurnRecord[]): TurnRepositoryPort {
  return {
    insert() {
      return ok({ cancelledAfterCommit: false });
    },
    complete() {
      return ok({ cancelledAfterCommit: false });
    },
    get(id: TurnId) {
      return ok(records.find((record) => record.turnId === id) ?? null);
    },
    listByParent(parentId: SessionId, _limit: number) {
      return ok(records.filter((record) => record.sessionId === parentId));
    },
  };
}

describe("createSessionNavigationController", () => {
  test("lists workspace sessions for the overlay", async () => {
    const record = sessionRecord();
    const store: SessionRecord[] = [record];
    const controller = createSessionNavigationController({
      sessions: memorySessions(store),
      turns: memoryTurns([]),
      events: createInMemoryEventStore(),
      workspaceId: record.workspaceId,
    });
    const listed = await controller.listSessions();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.some((entry) => entry.sessionId === String(record.sessionId))).toBe(true);
    }
  });

  test("resumes through the application port", async () => {
    const record = sessionRecord();
    const events = createInMemoryEventStore();
    await events.append(sessionStarted(1));
    const controller = createSessionNavigationController({
      sessions: memorySessions([record]),
      turns: memoryTurns([]),
      events,
      workspaceId: record.workspaceId,
    });
    const resumed = await controller.resume(String(record.sessionId));
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(noticeForResume(resumed.value)).toContain(String(record.sessionId));
    }
  });

  test("refuses rewind with an empty turn id", async () => {
    const record = sessionRecord();
    const turn = turnRecord({ sessionId: record.sessionId });
    const controller = createSessionNavigationController({
      sessions: memorySessions([record]),
      turns: memoryTurns([turn]),
      events: createInMemoryEventStore(),
      workspaceId: record.workspaceId,
    });
    const rewound = await controller.rewind(String(record.sessionId), "   ");
    expect(rewound.ok).toBe(false);
    if (!rewound.ok) {
      expect(rewound.error.code).toBe("empty");
    }
  });

  test("reports replay as effect-free in notices", async () => {
    const record = sessionRecord();
    const events = createInMemoryEventStore();
    await events.append(sessionStarted(1));
    await events.append(turnStarted(2));
    const controller = createSessionNavigationController({
      sessions: memorySessions([record]),
      turns: memoryTurns([]),
      events,
      workspaceId: record.workspaceId,
    });
    const replayed = await controller.replay(String(record.sessionId), "play");
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(replayed.value.effectFree).toBe(true);
      expect(noticeForReplay(replayed.value)).toContain("effect-free");
    }
  });
});
