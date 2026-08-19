/**
 * Application boundary for workspace and session isolation (#262).
 *
 * Lists sessions of the bound workspace and overlays observed root/Git
 * identity. This is not add-dir.
 */

import {
  err,
  inspectSessionIsolation,
  MAX_SESSION_CATALOG,
  type Result,
  type SessionIsolation,
  type SessionIsolationError,
  type SessionRepositoryPort,
  type WorkspaceId,
} from "../domain/index.ts";

function isolationError(
  code: SessionIsolationError["code"],
  field: string | null,
): SessionIsolationError {
  return { kind: "session-isolation", code, field };
}

export type WorkspaceBinding = {
  readonly workspaceId: WorkspaceId;
  readonly root: string | null;
  readonly gitIdentity: string | null;
};

export function isolateWorkspaceSessions(
  sessions: SessionRepositoryPort,
  input: {
    readonly bound: WorkspaceBinding;
    readonly observed?: WorkspaceBinding;
  },
  signal?: AbortSignal,
): Result<SessionIsolation, SessionIsolationError> {
  const listed = sessions.listByParent(input.bound.workspaceId, MAX_SESSION_CATALOG);
  if (!listed.ok) {
    return err(isolationError("malformed", "sessions"));
  }
  return inspectSessionIsolation(
    {
      bound: input.bound,
      observed: input.observed,
      sessions: listed.value.map((record) => ({
        sessionId: record.sessionId,
        workspaceId: record.workspaceId,
      })),
    },
    signal,
  );
}
