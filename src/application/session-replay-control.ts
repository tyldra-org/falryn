/**
 * Application boundary for transcript replay controls (#261).
 *
 * Reads recorded events and moves a cursor. Nothing is appended or invoked.
 */

import {
  controlSessionReplay,
  type EventStorePort,
  err,
  MAX_STREAM_READ_LIMIT,
  type Result,
  type SessionId,
  type SessionReplayControlError,
  type SessionReplayControlState,
  type SessionRepositoryPort,
} from "../domain/index.ts";

function controlErr(
  code: SessionReplayControlError["code"],
  field: string | null,
): SessionReplayControlError {
  return { kind: "session-replay-control", code, field };
}

export type ControlWorkspaceSessionReplayInput = {
  readonly sessionId: SessionId;
  readonly state?: SessionReplayControlState;
  readonly command: unknown;
};

export async function controlWorkspaceSessionReplay(
  sessions: SessionRepositoryPort,
  events: EventStorePort,
  input: ControlWorkspaceSessionReplayInput,
  signal?: AbortSignal,
): Promise<Result<SessionReplayControlState, SessionReplayControlError>> {
  if (signal?.aborted) {
    return err(controlErr("cancelled", "signal"));
  }
  const loaded = sessions.get(input.sessionId);
  if (!loaded.ok) {
    return err(controlErr("malformed", "session"));
  }
  if (loaded.value === null) {
    return err(controlErr("not-found", "session"));
  }
  const page = await events.readFrom(
    { streamId: loaded.value.streamId, afterSequence: null },
    MAX_STREAM_READ_LIMIT,
    signal,
  );
  if (!page.ok) {
    return err(controlErr(page.error.code === "cancelled" ? "cancelled" : "malformed", "events"));
  }
  return controlSessionReplay(
    {
      events: page.value,
      state: input.state,
      command: input.command,
    },
    signal,
  );
}
