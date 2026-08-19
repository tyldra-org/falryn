/**
 * Session rewind: fork a new lineage instead of rewriting history.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sessionId, streamId, turnId, workspaceId } from "./identity.ts";
import {
  describeSessionRewindError,
  planSessionRewind,
  SESSION_REWIND_SOURCE,
  SESSION_REWIND_VERSION,
} from "./session-rewind.ts";

const source = {
  sessionId: "session-source",
  streamId: "session:source",
  workspaceId: "workspace-source",
};

const identities = {
  sessionId: "session-fork",
  streamId: "session:fork",
  workspaceId: "workspace-fork",
};

describe("planSessionRewind", () => {
  test("rewinds to a selected turn as a new lineage", () => {
    const result = planSessionRewind({
      source,
      identities,
      turns: [{ turnId: "turn-a" }, { turnId: "turn-b" }],
      edit: { kind: "rewind", atTurnId: "turn-a" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.kind).toBe("rewind");
    expect(result.value.sourceSessionId).toBe(sessionId.from(source.sessionId));
    expect(result.value.sourceStreamId).toBe(streamId.from(source.streamId));
    expect(result.value.sessionId).toBe(sessionId.from(identities.sessionId));
    expect(result.value.parentTurnId).toBe(turnId.from("turn-a"));
    expect(result.value.provenance).toEqual({
      version: SESSION_REWIND_VERSION,
      source: SESSION_REWIND_SOURCE,
      model: null,
    });
  });

  test("forks with checkpoint identity from the latest turn", () => {
    const result = planSessionRewind({
      source,
      identities,
      turns: [{ turnId: "turn-a" }, { turnId: "turn-b" }],
      edit: { kind: "fork" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("fork");
      expect(result.value.parentTurnId).toBe(turnId.from("turn-b"));
    }
  });

  test("clones with an empty restore set", () => {
    const result = planSessionRewind({
      source,
      identities,
      turns: [{ turnId: "turn-a" }],
      edit: { kind: "clone" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("clone");
      expect(result.value.parentTurnId).toBeNull();
      expect(result.value.workspaceId).toBe(workspaceId.from(identities.workspaceId));
    }
  });

  test("refuses reusing the source stream as if rewind were an undo", () => {
    const result = planSessionRewind({
      source,
      identities: { ...identities, streamId: source.streamId },
      edit: { kind: "fork" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("refuses a rewind that names a turn outside the source", () => {
    const result = planSessionRewind({
      source,
      identities,
      turns: [{ turnId: "turn-a" }],
      edit: { kind: "rewind", atTurnId: "turn-missing" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
      expect(describeSessionRewindError(result.error)).toBe("not-found edit.atTurnId");
    }
  });

  test("allows an empty source so the first committed turn still has a lineage", () => {
    const result = planSessionRewind({
      source,
      identities,
      turns: [],
      edit: { kind: "fork" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.parentTurnId).toBeNull();
    }
  });

  test("treats cancellation as cancelled, not as a silent fork", () => {
    const result = planSessionRewind(
      { source, identities, edit: { kind: "clone" } },
      AbortSignal.abort(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const sourceText = await readFile(new URL("./session-rewind.ts", import.meta.url), "utf8");
    expect(sourceText).not.toMatch(
      /CommandRunnerPort|ProviderPort|GitPort|FileSystemPort|Bun\.spawn|child_process|fetch\(|git add|git commit/,
    );
  });
});
