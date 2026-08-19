/**
 * Application boundary for crash-safe session resume (#259).
 *
 * Reads the next page after a durable cursor. The plan continues the same
 * session; it does not append, fork, or call a tool.
 */

import {
  type EventCursor,
  type EventStorePort,
  err,
  PROJECTION_PAGE_SIZE,
  planSessionResume,
  type Result,
  type SessionId,
  type SessionRepositoryPort,
  type SessionResumeError,
  type SessionResumePlan,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
} from "../domain/index.ts";

function resumeError(code: SessionResumeError["code"], field: string | null): SessionResumeError {
  return { kind: "session-resume", code, field };
}

export type ResumeWorkspaceSessionInput = {
  readonly sessionId: SessionId;
  readonly cursor?: {
    readonly afterSequence: EventCursor["afterSequence"];
    readonly schemaGeneration: number;
  } | null;
};

export async function resumeWorkspaceSession(
  sessions: SessionRepositoryPort,
  events: EventStorePort,
  input: ResumeWorkspaceSessionInput,
  signal?: AbortSignal,
): Promise<Result<SessionResumePlan, SessionResumeError>> {
  if (signal?.aborted) {
    return err(resumeError("cancelled", "signal"));
  }
  const loaded = sessions.get(input.sessionId);
  if (!loaded.ok) {
    return err(resumeError("malformed", "session"));
  }
  if (loaded.value === null) {
    return err(resumeError("not-found", "session"));
  }
  const session = loaded.value;
  const recorded = input.cursor;
  const cursor =
    recorded === undefined || recorded === null
      ? null
      : {
          streamId: session.streamId,
          afterSequence: recorded.afterSequence,
          schemaGeneration: recorded.schemaGeneration,
        };
  const readCursor: EventCursor = {
    streamId: session.streamId,
    afterSequence:
      cursor === null || cursor.schemaGeneration !== TERMINAL_OUTCOME_PROJECTION_GENERATION
        ? null
        : cursor.afterSequence,
  };
  const page = await events.readFrom(readCursor, PROJECTION_PAGE_SIZE, signal);
  if (!page.ok) {
    return err(resumeError(page.error.code === "cancelled" ? "cancelled" : "malformed", "events"));
  }
  return planSessionResume(
    {
      session: {
        sessionId: session.sessionId,
        streamId: session.streamId,
        closedAt: session.closedAt,
      },
      cursor,
      events: page.value,
    },
    signal,
  );
}
