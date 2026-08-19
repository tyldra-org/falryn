/**
 * Session resume: continue the same session from a durable cursor.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sessionStarted, turnStarted } from "./fixtures.ts";
import { FIRST_SEQUENCE, sequence, sessionId, streamId } from "./identity.ts";
import { TERMINAL_OUTCOME_PROJECTION_GENERATION } from "./projection.ts";
import {
  describeSessionResumeError,
  planSessionResume,
  SESSION_RESUME_SOURCE,
  SESSION_RESUME_VERSION,
} from "./session-resume.ts";

const session = {
  sessionId: "session-fixture",
  streamId: "session:fixture-session",
  closedAt: null,
};

describe("planSessionResume", () => {
  test("continues the same session after the durable cursor", () => {
    const result = planSessionResume({
      session,
      cursor: {
        streamId: session.streamId,
        afterSequence: 1,
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
      },
      events: [turnStarted(2)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.kind).toBe("continue");
    expect(result.value.sessionId).toBe(sessionId.from(session.sessionId));
    expect(result.value.cursor).toEqual({
      streamId: streamId.from(session.streamId),
      afterSequence: sequence.from(1),
    });
    expect(result.value.pending).toBe(1);
    expect(result.value.provenance).toEqual({
      version: SESSION_RESUME_VERSION,
      source: SESSION_RESUME_SOURCE,
      model: null,
    });
  });

  test("rebuilds from the start when the cursor generation is stale", () => {
    const result = planSessionResume({
      session,
      cursor: {
        streamId: session.streamId,
        afterSequence: 4,
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION + 1,
      },
      events: [sessionStarted(1)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.kind).toBe("rebuild");
    expect(result.value.cursor.afterSequence).toBeNull();
    expect(result.value.sessionId).toBe(sessionId.from(session.sessionId));
  });

  test("rebuilds from the start when no cursor was recorded", () => {
    const result = planSessionResume({
      session,
      events: [sessionStarted(FIRST_SEQUENCE)],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("rebuild");
      expect(result.value.cursor.afterSequence).toBeNull();
    }
  });

  test("refuses a closed session instead of opening a fork", () => {
    const result = planSessionResume({
      session: { ...session, closedAt: "2026-07-31T13:00:00.000Z" },
      cursor: {
        streamId: session.streamId,
        afterSequence: 1,
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("closed");
      expect(describeSessionResumeError(result.error)).toBe("closed session");
    }
  });

  test("refuses a cursor that names a different stream", () => {
    const result = planSessionResume({
      session,
      cursor: {
        streamId: "session:other-session",
        afterSequence: 1,
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("refuses a gap after the durable cursor rather than skipping it", () => {
    const result = planSessionResume({
      session,
      cursor: {
        streamId: session.streamId,
        afterSequence: 1,
        schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
      },
      events: [turnStarted(3)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("treats cancellation as cancelled, not as an empty resume", () => {
    const result = planSessionResume({ session }, AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const source = await readFile(new URL("./session-resume.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /CommandRunnerPort|ProviderPort|GitPort|FileSystemPort|Bun\.spawn|child_process|fetch\(|git add|git commit/,
    );
  });
});
