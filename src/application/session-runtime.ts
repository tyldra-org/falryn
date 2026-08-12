/**
 * In-memory session runtime over the session lifecycle machine.
 *
 * Owns live session snapshots and observation history for one process. Durable
 * persistence and event append belong to later owners; this surface is the
 * public entry that keeps phase transitions exhaustive and rejectable.
 */

import {
  applySessionTransition,
  type ConfigurationGeneration,
  createSessionSnapshot,
  type EventId,
  type SessionCommand,
  type SessionId,
  type SessionObservation,
  type SessionSnapshot,
  type SessionTransitionError,
  type TerminalOutcome,
  type WorkspaceId,
} from "../domain/index.ts";

export type SessionRuntimeError =
  | SessionTransitionError
  | { readonly code: "session-not-found"; readonly sessionId: SessionId }
  | { readonly code: "session-already-exists"; readonly sessionId: SessionId };

export type SessionRuntimeResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: SessionRuntimeError };

export type OpenSessionInput = {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly configurationGeneration: ConfigurationGeneration;
};

export type SessionCommandInput = {
  readonly sessionId: SessionId;
  readonly command: SessionCommand;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly causationEventId?: EventId | null;
  readonly outcome?: TerminalOutcome | null;
};

export type SessionRuntime = {
  /** Creates a session in bootstrap. Named `create` so it is not mistaken for a byte open. */
  create(input: OpenSessionInput): SessionRuntimeResult<SessionSnapshot>;
  apply(input: SessionCommandInput): SessionRuntimeResult<{
    readonly snapshot: SessionSnapshot;
    readonly observation: SessionObservation;
  }>;
  get(sessionId: SessionId): SessionSnapshot | null;
  observations(sessionId: SessionId): readonly SessionObservation[];
  sessions(): readonly SessionSnapshot[];
};

export function createSessionRuntime(): SessionRuntime {
  const snapshots = new Map<SessionId, SessionSnapshot>();
  const history = new Map<SessionId, SessionObservation[]>();

  return {
    create(input) {
      if (snapshots.has(input.sessionId)) {
        return {
          ok: false,
          error: { code: "session-already-exists", sessionId: input.sessionId },
        };
      }
      const snapshot = createSessionSnapshot(input);
      snapshots.set(input.sessionId, snapshot);
      history.set(input.sessionId, []);
      return { ok: true, value: snapshot };
    },

    apply(input) {
      const current = snapshots.get(input.sessionId);
      if (current === undefined) {
        return {
          ok: false,
          error: { code: "session-not-found", sessionId: input.sessionId },
        };
      }

      const result = applySessionTransition({
        snapshot: current,
        command: input.command,
        configurationGeneration: input.configurationGeneration,
        ...(input.causationEventId === undefined
          ? {}
          : { causationEventId: input.causationEventId }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      });

      if (result.kind === "rejected") {
        return { ok: false, error: result.error };
      }

      snapshots.set(input.sessionId, result.snapshot);
      const prior = history.get(input.sessionId) ?? [];
      history.set(input.sessionId, [...prior, result.observation]);
      return {
        ok: true,
        value: { snapshot: result.snapshot, observation: result.observation },
      };
    },

    get(sessionId) {
      return snapshots.get(sessionId) ?? null;
    },

    observations(sessionId) {
      return history.get(sessionId) ?? [];
    },

    sessions() {
      return [...snapshots.values()];
    },
  };
}
