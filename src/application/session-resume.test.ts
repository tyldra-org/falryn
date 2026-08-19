/**
 * Application-boundary session resume: load the next page, never append.
 */

import { describe, expect, test } from "bun:test";
import { sessionRecord, sessionStarted, turnStarted } from "../domain/fixtures.ts";
import {
  createInMemoryEventStore,
  ok,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  sequence,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
  type WorkspaceId,
} from "../domain/index.ts";
import { resumeWorkspaceSession } from "./session-resume.ts";

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

describe("resumeWorkspaceSession", () => {
  test("continues after a durable cursor without appending", async () => {
    const record = sessionRecord();
    const events = createInMemoryEventStore();
    const started = await events.append(sessionStarted(1));
    const next = await events.append(turnStarted(2));
    expect(started.ok && next.ok).toBe(true);
    const result = await resumeWorkspaceSession(memorySessions([record]), events, {
      sessionId: record.sessionId,
      cursor: {
        afterSequence: sequence.from(1),
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("continue");
      expect(result.value.pending).toBe(1);
      expect(result.value.sessionId).toBe(record.sessionId);
    }
  });

  test("rebuilds the same session when no cursor was recorded", async () => {
    const record = sessionRecord();
    const events = createInMemoryEventStore();
    await events.append(sessionStarted(1));
    const result = await resumeWorkspaceSession(memorySessions([record]), events, {
      sessionId: record.sessionId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("rebuild");
      expect(result.value.cursor.afterSequence).toBeNull();
      expect(result.value.pending).toBe(1);
    }
  });

  test("refuses a session the repository does not have", async () => {
    const record = sessionRecord();
    const result = await resumeWorkspaceSession(memorySessions([]), createInMemoryEventStore(), {
      sessionId: record.sessionId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
    }
  });
});
