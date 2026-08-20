/**
 * Application-boundary session catalog: secrets fail closed, list is advice.
 */

import { describe, expect, test } from "bun:test";
import { sessionRecord } from "../domain/fixtures.ts";
import {
  ok,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  type WorkspaceId,
} from "../domain/index.ts";
import {
  editWorkspaceSessionCatalog,
  inspectWorkspaceSession,
  queryWorkspaceSessions,
} from "./session-catalog.ts";

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

describe("queryWorkspaceSessions", () => {
  test("refuses a secret-shaped search without echoing it", () => {
    const sessions = memorySessions([sessionRecord()]);
    const result = queryWorkspaceSessions(sessions, {
      workspaceId: sessionRecord().workspaceId,
      search: "token sk-live-SECRET must remain",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("secret");
    }
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });

  test("lists ordinary sessions and honors a pin overlay", () => {
    const record = sessionRecord({ title: "Export restore" });
    const sessions = memorySessions([record]);
    const result = queryWorkspaceSessions(sessions, {
      workspaceId: record.workspaceId,
      filter: "pinned",
      pinnedIds: [record.sessionId],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessions).toHaveLength(1);
      expect(result.value.sessions[0]?.pinned).toBe(true);
    }
  });

  test("redacts a secret-shaped title without echoing it", () => {
    const record = sessionRecord({ title: "token sk-live-SECRET-title" });
    const sessions = memorySessions([record]);
    const result = queryWorkspaceSessions(sessions, { workspaceId: record.workspaceId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result)).not.toContain("sk-live-SECRET-title");
      expect(result.value.sessions[0]?.title).toContain("[redacted]");
    }
  });

  test("bounds a long list and reports how many rows it omitted", () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      sessionRecord({
        sessionId: `s${index}` as never,
        title: `Session ${index}`,
        startedAt: `2026-07-31T12:00:0${index}.000Z` as never,
      }),
    );
    const sessions = memorySessions(records);
    const result = queryWorkspaceSessions(sessions, {
      workspaceId: sessionRecord().workspaceId,
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessions).toHaveLength(2);
      expect(result.value.omitted).toBe(3);
    }
  });
});

describe("editWorkspaceSessionCatalog", () => {
  test("renames a loaded session in the catalog snapshot", () => {
    const record = sessionRecord({ title: "Old" });
    const sessions = memorySessions([record]);
    const result = editWorkspaceSessionCatalog(sessions, {
      workspaceId: record.workspaceId,
      edit: { kind: "rename", sessionId: record.sessionId, title: "Named export" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessions[0]?.title).toBe("Named export");
    }
  });
});

describe("inspectWorkspaceSession", () => {
  test("returns a bound session and refuses a foreign one as not-found", () => {
    const bound = sessionRecord({ sessionId: "keep" as never, title: "Keep" });
    const foreign = sessionRecord({
      sessionId: "foreign" as never,
      workspaceId: "workspace-other" as never,
      title: "Other",
    });
    const sessions = memorySessions([bound, foreign]);
    const kept = inspectWorkspaceSession(sessions, {
      workspaceId: bound.workspaceId,
      sessionId: bound.sessionId,
    });
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.value.entry.sessionId).toBe(bound.sessionId);
    }
    const other = inspectWorkspaceSession(sessions, {
      workspaceId: bound.workspaceId,
      sessionId: foreign.sessionId,
    });
    expect(other.ok).toBe(false);
    if (!other.ok && "code" in other.error) {
      expect(other.error.code).toBe("not-found");
    }
  });
});
