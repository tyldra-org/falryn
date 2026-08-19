/**
 * Application-boundary rewind: insert a new session, leave the source stream.
 */

import { describe, expect, test } from "bun:test";
import { sessionRecord, turnRecord } from "../domain/fixtures.ts";
import {
  err,
  ok,
  type RecordError,
  type RecordWrite,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  sessionId,
  streamId,
  type TurnId,
  type TurnRecord,
  type TurnRepositoryPort,
  turnId,
  type WorkspaceId,
  workspaceId,
} from "../domain/index.ts";
import { rewindWorkspaceSession } from "./session-rewind.ts";

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
    complete(): never {
      throw new Error("complete is not this slice");
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
    insert(): never {
      throw new Error("insert is not this slice");
    },
    complete(): never {
      throw new Error("complete is not this slice");
    },
    get(id: TurnId) {
      return ok(records.find((record) => record.turnId === id) ?? null);
    },
    listByParent(parentId: SessionId, _limit: number) {
      return ok(records.filter((record) => record.sessionId === parentId));
    },
  };
}

describe("rewindWorkspaceSession", () => {
  test("inserts a rewind lineage without rewriting the source session", () => {
    const source = sessionRecord({ title: "Export restore" });
    const first = turnRecord({ turnId: turnId.from("turn-a") });
    const store = [source];
    const result = rewindWorkspaceSession(memorySessions(store), memoryTurns([first]), {
      sourceSessionId: source.sessionId,
      identities: {
        sessionId: sessionId.from("session-fork"),
        streamId: streamId.from("session:fork"),
        workspaceId: workspaceId.from("workspace-fork"),
      },
      edit: { kind: "rewind", atTurnId: first.turnId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.kind).toBe("rewind");
    expect(result.value.parentTurnId).toBe(first.turnId);
    expect(store).toHaveLength(2);
    expect(store[0]?.sessionId).toBe(source.sessionId);
    expect(store[0]?.streamId).toBe(source.streamId);
    expect(store[1]?.sessionId).toBe(sessionId.from("session-fork"));
    expect(store[1]?.closedAt).toBeNull();
  });

  test("clones without copying checkpoint identity", () => {
    const source = sessionRecord();
    const result = rewindWorkspaceSession(memorySessions([source]), memoryTurns([turnRecord()]), {
      sourceSessionId: source.sessionId,
      identities: {
        sessionId: sessionId.from("session-clone"),
        streamId: streamId.from("session:clone"),
        workspaceId: source.workspaceId,
      },
      edit: { kind: "clone" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("clone");
      expect(result.value.parentTurnId).toBeNull();
    }
  });

  test("refuses a source the repository does not have", () => {
    const result = rewindWorkspaceSession(memorySessions([]), memoryTurns([]), {
      sourceSessionId: sessionRecord().sessionId,
      identities: {
        sessionId: sessionId.from("session-fork"),
        streamId: streamId.from("session:fork"),
        workspaceId: workspaceId.from("workspace-fork"),
      },
      edit: { kind: "fork" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
    }
  });
});
