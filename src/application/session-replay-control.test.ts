/**
 * Application-boundary replay controls: read recorded events, never append.
 */

import { describe, expect, test } from "bun:test";
import { sessionRecord, sessionStarted, turnStarted } from "../domain/fixtures.ts";
import {
  createInMemoryEventStore,
  ok,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  type WorkspaceId,
} from "../domain/index.ts";
import { controlWorkspaceSessionReplay } from "./session-replay-control.ts";

function memorySessions(records: readonly SessionRecord[]): SessionRepositoryPort {
  return {
    insert(): never {
      throw new Error("insert is not this slice");
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

describe("controlWorkspaceSessionReplay", () => {
  test("steps a loaded stream without appending", async () => {
    const record = sessionRecord();
    const events = createInMemoryEventStore();
    await events.append(sessionStarted(1));
    await events.append(turnStarted(2));
    const result = await controlWorkspaceSessionReplay(memorySessions([record]), events, {
      sessionId: record.sessionId,
      command: { kind: "step" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("paused");
      expect(result.value.applied).toBe(1);
    }
    const after = await events.readFrom({ streamId: record.streamId, afterSequence: null }, 10);
    expect(after.ok && after.value.length === 2).toBe(true);
  });

  test("refuses a session the repository does not have", async () => {
    const result = await controlWorkspaceSessionReplay(
      memorySessions([]),
      createInMemoryEventStore(),
      { sessionId: sessionRecord().sessionId, command: { kind: "play" } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
    }
  });
});
