/**
 * Session-navigation child-seam scenarios across #258–#263.
 *
 * List, resume, rewind, replay, isolation, and recovery stay distinct modules.
 * Each step keeps its own provenance and never rewrites another seam's history.
 */

import { describe, expect, test } from "bun:test";

import { sessionStarted, turnStarted } from "./fixtures.ts";
import { sessionId, streamId, turnId } from "./identity.ts";
import { TERMINAL_OUTCOME_PROJECTION_GENERATION } from "./projection.ts";
import { querySessionCatalog } from "./session-catalog.ts";
import { inspectSessionIsolation } from "./session-isolation.ts";
import { planSessionRecovery } from "./session-recovery.ts";
import {
  controlSessionReplay,
  SESSION_REPLAY_CONTROL_SOURCE,
  SESSION_REPLAY_CONTROL_VERSION,
} from "./session-replay-control.ts";
import {
  planSessionResume,
  SESSION_RESUME_SOURCE,
  SESSION_RESUME_VERSION,
} from "./session-resume.ts";
import {
  planSessionRewind,
  SESSION_REWIND_SOURCE,
  SESSION_REWIND_VERSION,
} from "./session-rewind.ts";

const workspaceId = "workspace-bound";
const bound = {
  workspaceId,
  root: "/repo",
  gitIdentity: "github.com/tyldra-org/falryn",
};

describe("session navigation scenarios", () => {
  test("lists an open session, resumes it, and exports it without mixing seams", () => {
    const catalog = querySessionCatalog({
      sessions: [
        {
          sessionId: "session-fixture",
          title: "Alpha",
          pinned: false,
          startedAt: "2026-07-31T12:00:00.000Z",
          closedAt: null,
        },
      ],
      filter: "open",
    });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) {
      return;
    }
    expect(catalog.value.sessions).toHaveLength(1);
    expect(catalog.value.provenance.model).toBeNull();

    const stream = streamId.from("session:fixture-session");
    const resume = planSessionResume({
      session: { sessionId: "session-fixture", streamId: stream, closedAt: null },
      cursor: {
        streamId: stream,
        afterSequence: 1,
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
      },
      events: [turnStarted(2)],
    });
    expect(resume.ok).toBe(true);
    if (resume.ok) {
      expect(resume.value.kind).toBe("continue");
      expect(resume.value.provenance).toEqual({
        version: SESSION_RESUME_VERSION,
        source: SESSION_RESUME_SOURCE,
        model: null,
      });
    }

    const recovery = planSessionRecovery({
      kind: "export",
      sessionIds: ["session-fixture"],
    });
    expect(recovery.ok).toBe(true);
    if (recovery.ok && recovery.value.kind === "export") {
      expect(recovery.value.sessionIds).toEqual([sessionId.from("session-fixture")]);
    }
  });

  test("rewinds into a fork while replay stays cursor-only", () => {
    const rewind = planSessionRewind({
      source: {
        sessionId: "source",
        streamId: "session:source",
        workspaceId,
      },
      turns: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
      identities: {
        sessionId: "forked",
        streamId: "session:forked",
        workspaceId,
      },
      edit: { kind: "rewind", atTurnId: "turn-1" },
    });
    expect(rewind.ok).toBe(true);
    if (rewind.ok) {
      expect(rewind.value.kind).toBe("rewind");
      expect(rewind.value.sourceSessionId).toBe(sessionId.from("source"));
      expect(rewind.value.provenance).toEqual({
        version: SESSION_REWIND_VERSION,
        source: SESSION_REWIND_SOURCE,
        model: null,
      });
    }

    const replay = controlSessionReplay({
      events: [sessionStarted(1), turnStarted(2)],
      command: { kind: "seek", sequence: 1 },
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.applied).toBe(1);
      expect(replay.value.provenance).toEqual({
        version: SESSION_REPLAY_CONTROL_VERSION,
        source: SESSION_REPLAY_CONTROL_SOURCE,
        model: null,
      });
    }
  });

  test("isolates the bound workspace and plans verified import separately", () => {
    const isolation = inspectSessionIsolation({
      bound,
      observed: { ...bound, root: "/moved" },
      sessions: [
        { sessionId: "keep", workspaceId },
        { sessionId: "foreign", workspaceId: "workspace-other" },
      ],
    });
    expect(isolation.ok).toBe(true);
    if (isolation.ok) {
      expect(isolation.value.warnings).toEqual(["stale-root"]);
      expect(isolation.value.omitted).toBe(1);
    }

    const unverified = planSessionRecovery({
      kind: "import",
      packageName: "portable",
      verified: false,
    });
    expect(unverified.ok).toBe(false);

    const verified = planSessionRecovery({
      kind: "import",
      packageName: "portable",
      verified: true,
    });
    expect(verified.ok).toBe(true);
  });

  test("rewind parent turn identity is preserved on fork plans", () => {
    const rewind = planSessionRewind({
      source: {
        sessionId: "source",
        streamId: "session:source",
        workspaceId,
      },
      turns: [{ turnId: "turn-1" }],
      identities: {
        sessionId: "forked",
        streamId: "session:forked",
        workspaceId,
      },
      edit: { kind: "rewind", atTurnId: "turn-1" },
    });
    expect(rewind.ok).toBe(true);
    if (rewind.ok) {
      expect(rewind.value.parentTurnId).toBe(turnId.from("turn-1"));
    }
  });
});
