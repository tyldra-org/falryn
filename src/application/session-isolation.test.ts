/**
 * Application-boundary isolation: bound workspace only.
 */

import { describe, expect, test } from "bun:test";
import { sessionRecord } from "../domain/fixtures.ts";
import {
  ok,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  type WorkspaceId,
  workspaceId,
} from "../domain/index.ts";
import { isolateWorkspaceSessions } from "./session-isolation.ts";

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

describe("isolateWorkspaceSessions", () => {
  test("warns on a stale root without mixing another workspace in", () => {
    const record = sessionRecord();
    const result = isolateWorkspaceSessions(memorySessions([record]), {
      bound: {
        workspaceId: record.workspaceId,
        root: "/repo",
        gitIdentity: "github.com/tyldra-org/falryn",
      },
      observed: {
        workspaceId: record.workspaceId,
        root: "/moved",
        gitIdentity: "github.com/tyldra-org/falryn",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toEqual(["stale-root"]);
      expect(result.value.sessions).toHaveLength(1);
      expect(result.value.workspaceId).toBe(workspaceId.from(record.workspaceId));
    }
  });
});
