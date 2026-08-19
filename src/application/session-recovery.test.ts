/**
 * Application-boundary recovery: export scope and secret fail-closed.
 */

import { describe, expect, test } from "bun:test";

import { sessionRecord } from "../domain/fixtures.ts";
import {
  ok,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
} from "../domain/index.ts";
import { planWorkspaceSessionRecovery } from "./session-recovery.ts";

const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";

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
    listByParent(): never {
      throw new Error("listByParent is not this slice");
    },
  };
}

describe("planWorkspaceSessionRecovery", () => {
  test("refuses export when a session id is missing", () => {
    const record = sessionRecord();
    const result = planWorkspaceSessionRecovery(memorySessions([record]), {
      kind: "export",
      sessionIds: [record.sessionId, "missing"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
    }
  });

  test("refuses secret-shaped backup names without echoing them", () => {
    const result = planWorkspaceSessionRecovery(memorySessions([]), {
      kind: "backup",
      name: SECRET,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
      expect(JSON.stringify(result.error)).not.toContain(SECRET);
    }
  });

  test("plans export when every session exists", () => {
    const record = sessionRecord();
    const result = planWorkspaceSessionRecovery(memorySessions([record]), {
      kind: "export",
      sessionIds: [record.sessionId],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("export");
    }
  });
});
