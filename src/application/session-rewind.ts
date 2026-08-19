/**
 * Application boundary for session fork and rewind-as-new-history (#260).
 *
 * Inserts a new session under new identities. Events stay on the source
 * stream. The source row is not closed, truncated, or rewritten.
 */

import {
  configurationGeneration,
  err,
  MAX_RECORD_LIST_LIMIT,
  ok,
  planSessionRewind,
  type Result,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  type SessionRewindError,
  type SessionRewindKind,
  type SessionRewindPlan,
  type StreamId,
  type TurnRepositoryPort,
  type WorkspaceId,
} from "../domain/index.ts";

function rewindError(code: SessionRewindError["code"], field: string | null): SessionRewindError {
  return { kind: "session-rewind", code, field };
}

export type RewindWorkspaceSessionInput = {
  readonly sourceSessionId: SessionId;
  readonly identities: {
    readonly sessionId: SessionId;
    readonly streamId: StreamId;
    readonly workspaceId: WorkspaceId;
  };
  readonly edit:
    | { readonly kind: "rewind"; readonly atTurnId: string }
    | { readonly kind: "fork" }
    | { readonly kind: "clone" };
};

function insertFork(
  sessions: SessionRepositoryPort,
  source: SessionRecord,
  identities: RewindWorkspaceSessionInput["identities"],
  signal?: AbortSignal,
): Result<null, SessionRewindError> {
  const existing = sessions.get(identities.sessionId);
  if (!existing.ok) {
    return err(rewindError("malformed", "identities.sessionId"));
  }
  if (existing.value !== null) {
    return err(rewindError("malformed", "identities.sessionId"));
  }
  const inserted = sessions.insert(
    {
      ...source,
      sessionId: identities.sessionId,
      streamId: identities.streamId,
      workspaceId: identities.workspaceId,
      configurationGeneration: configurationGeneration.from(source.configurationGeneration + 1),
      closedAt: null,
      outcome: null,
    },
    signal,
  );
  if (!inserted.ok) {
    return err(rewindError("malformed", "session"));
  }
  return ok(null);
}

export function rewindWorkspaceSession(
  sessions: SessionRepositoryPort,
  turns: TurnRepositoryPort,
  input: RewindWorkspaceSessionInput,
  signal?: AbortSignal,
): Result<SessionRewindPlan, SessionRewindError> {
  if (signal?.aborted) {
    return err(rewindError("cancelled", "signal"));
  }
  const source = sessions.get(input.sourceSessionId);
  if (!source.ok) {
    return err(rewindError("malformed", "source"));
  }
  if (source.value === null) {
    return err(rewindError("not-found", "source"));
  }
  const listed = turns.listByParent(input.sourceSessionId, MAX_RECORD_LIST_LIMIT);
  if (!listed.ok) {
    return err(rewindError("malformed", "turns"));
  }
  const planned = planSessionRewind(
    {
      source: {
        sessionId: source.value.sessionId,
        streamId: source.value.streamId,
        workspaceId: source.value.workspaceId,
      },
      turns: listed.value.map((turn) => ({ turnId: turn.turnId })),
      identities: input.identities,
      edit: input.edit,
    },
    signal,
  );
  if (!planned.ok) {
    return planned;
  }
  const written = insertFork(sessions, source.value, input.identities, signal);
  if (!written.ok) {
    return written;
  }
  return planned;
}

export type { SessionRewindKind };
