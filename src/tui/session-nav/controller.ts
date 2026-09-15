import type { SessionActivationPort } from "../../application/sessions/session-activation.ts";
/**
 * Application-backed session navigation for the interactive shell (#722).
 *
 * Lists sessions and turn ids from domain ports, then calls the same resume,
 * fork, rewind, and replay application functions the CLI uses. Replay is
 * cursor-only and never repeats tool or provider effects.
 */

import {
  controlWorkspaceSessionReplay,
  queryWorkspaceSessions,
  resumeWorkspaceSession,
  rewindWorkspaceSession,
} from "../../application/sessions/index.ts";
import {
  type SessionId,
  sessionId,
  streamId,
  type WorkspaceId,
} from "../../domain/foundation/index.ts";
import {
  type EventStorePort,
  type SessionRepositoryPort,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
  type TurnRepositoryPort,
} from "../../domain/sessions/index.ts";
import type { ReplayAction } from "./format.ts";

export type SessionNavigationControllerError =
  | { readonly code: "cancelled" }
  | { readonly code: "empty" }
  | { readonly code: "absent" }
  | { readonly code: "not-found" }
  | { readonly code: "navigation"; readonly detail: string };

export type SessionNavListEntry = {
  readonly sessionId: string;
  readonly title: string;
  readonly detail: string;
};

export type SessionNavTurnEntry = {
  readonly turnId: string;
  readonly detail: string;
};

export type SessionResumeResult = {
  readonly explanation?: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly pending: number;
  readonly afterSequence: number | null;
};

export type SessionForkResult = {
  readonly explanation?: string;
  readonly sourceSessionId: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly kind: "fork" | "rewind";
  readonly atTurnId: string | null;
};

export type SessionReplayResult = {
  readonly sessionId: string;
  readonly status: string;
  readonly atSequence: number | null;
  readonly applied: number;
  readonly effectFree: true;
};

export type SessionNavigationController = {
  readonly workspaceId: string;
  listSessions(
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: readonly SessionNavListEntry[] }
    | { readonly ok: false; readonly error: SessionNavigationControllerError }
  >;
  listTurns(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: readonly SessionNavTurnEntry[] }
    | { readonly ok: false; readonly error: SessionNavigationControllerError }
  >;
  resume(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: SessionResumeResult }
    | { readonly ok: false; readonly error: SessionNavigationControllerError }
  >;
  fork(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: SessionForkResult }
    | { readonly ok: false; readonly error: SessionNavigationControllerError }
  >;
  rewind(
    sessionId: string,
    atTurnId: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: SessionForkResult }
    | { readonly ok: false; readonly error: SessionNavigationControllerError }
  >;
  replay(
    sessionId: string,
    action: ReplayAction,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: SessionReplayResult }
    | { readonly ok: false; readonly error: SessionNavigationControllerError }
  >;
};

function navigationError(detail: string): SessionNavigationControllerError {
  return { code: "navigation", detail };
}

function parseSessionId(value: string): SessionId | null {
  const parsed = sessionId.parse(value);
  return parsed.ok ? parsed.value : null;
}

export function describeSessionNavigationControllerError(
  error: SessionNavigationControllerError,
): string {
  switch (error.code) {
    case "cancelled":
      return "Session navigation was cancelled.";
    case "empty":
      return "Turn id is required for rewind.";
    case "absent":
      return "No local session store is present.";
    case "not-found":
      return "That session was not found.";
    case "navigation":
      return `Session navigation failed (${error.detail}).`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

export function noticeForResume(result: SessionResumeResult): string {
  if (result.explanation) return result.explanation;
  const pending = result.pending === 1 ? "1 pending event" : `${result.pending} pending events`;
  return `Resumed session ${result.sessionId} (${pending}).`;
}

export function noticeForFork(result: SessionForkResult): string {
  if (result.explanation) return result.explanation;
  if (result.kind === "rewind") {
    return `Rewound ${result.sourceSessionId} at turn ${result.atTurnId ?? "?"} → ${result.sessionId}.`;
  }
  return `Forked ${result.sourceSessionId} → ${result.sessionId}.`;
}

export function noticeForReplay(result: SessionReplayResult): string {
  const at = result.atSequence === null ? "start" : `sequence ${result.atSequence}`;
  return `Replay ${result.status} at ${at} (effect-free; ${result.applied} applied).`;
}

export function createSessionNavigationController(options: {
  readonly activation?: SessionActivationPort;
  readonly sessions: SessionRepositoryPort;
  readonly turns: TurnRepositoryPort;
  readonly events: EventStorePort;
  readonly workspaceId: WorkspaceId;
}): SessionNavigationController {
  const workspaceId = options.workspaceId;
  const observed = new Map<string, { generation: number; throughSequence: number }>();

  return {
    workspaceId: String(workspaceId),

    async listSessions(signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const catalog = queryWorkspaceSessions(options.sessions, { workspaceId }, signal);
      if (!catalog.ok) {
        return { ok: false, error: navigationError(catalog.error.code) };
      }
      observed.clear();
      for (const entry of catalog.value.sessions) {
        const record = options.sessions.get(entry.sessionId);
        if (!record.ok || !record.value) continue;
        const head = options.events.head?.(record.value.streamId);
        if (head?.ok)
          observed.set(String(entry.sessionId), {
            generation: Number(record.value.configurationGeneration),
            throughSequence: Number(head.value ?? 0),
          });
      }
      return {
        ok: true,
        value: catalog.value.sessions.map((entry) => ({
          sessionId: String(entry.sessionId),
          title: entry.title ?? String(entry.sessionId),
          detail: entry.closedAt === null ? "open" : "closed",
        })),
      };
    },

    async listTurns(sessionIdText, signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsed = parseSessionId(sessionIdText);
      if (parsed === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      const listed = options.turns.listByParent(parsed, 256);
      if (!listed.ok) {
        return { ok: false, error: navigationError(listed.error.code) };
      }
      return {
        ok: true,
        value: listed.value.map((turn, index) => ({
          turnId: String(turn.turnId),
          detail: `turn ${index + 1}`,
        })),
      };
    },

    async resume(sessionIdText, signal) {
      if (options.activation) {
        const selection = observed.get(sessionIdText);
        const result = await options.activation.activate(
          {
            kind: "resume",
            sessionId: sessionIdText,
            ...(selection ? { observed: selection } : {}),
          },
          signal,
        );
        if (!result.ok) return { ok: false, error: navigationError(result.reason) };
        return {
          ok: true,
          value: {
            sessionId: result.sessionId,
            streamId: result.streamId,
            explanation: result.explanation,
            pending: 0,
            afterSequence: null,
          },
        };
      }

      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsed = parseSessionId(sessionIdText);
      if (parsed === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      const resumed = await resumeWorkspaceSession(
        options.sessions,
        options.events,
        {
          sessionId: parsed,
          cursor: {
            afterSequence: null,
            schemaGeneration: TERMINAL_OUTCOME_PROJECTION_GENERATION,
          },
        },
        signal,
      );
      if (!resumed.ok) {
        return { ok: false, error: navigationError(resumed.error.code) };
      }
      return {
        ok: true,
        value: {
          sessionId: String(resumed.value.sessionId),
          streamId: String(resumed.value.streamId),
          pending: resumed.value.pending,
          afterSequence:
            resumed.value.cursor.afterSequence === null
              ? null
              : Number(resumed.value.cursor.afterSequence),
        },
      };
    },

    async fork(sessionIdText, signal) {
      if (options.activation) {
        const selection = observed.get(sessionIdText);
        const result = await options.activation.activate(
          { kind: "fork", sessionId: sessionIdText, ...(selection ? { observed: selection } : {}) },
          signal,
        );
        if (!result.ok) return { ok: false, error: navigationError(result.reason) };
        return {
          ok: true,
          value: {
            sessionId: result.sessionId,
            streamId: result.streamId,
            explanation: result.explanation,
            sourceSessionId: sessionIdText,
            kind: "fork",
            atTurnId: null,
          },
        };
      }

      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsed = parseSessionId(sessionIdText);
      if (parsed === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      const suffix = crypto.randomUUID();
      const planned = rewindWorkspaceSession(
        options.sessions,
        options.turns,
        {
          sourceSessionId: parsed,
          identities: {
            sessionId: sessionId.from(`fork-${suffix}`),
            streamId: streamId.from(`stream-fork-${suffix}`),
            workspaceId,
          },
          edit: { kind: "fork" },
        },
        signal,
      );
      if (!planned.ok) {
        return { ok: false, error: navigationError(planned.error.code) };
      }
      return {
        ok: true,
        value: {
          sourceSessionId: sessionIdText,
          sessionId: String(planned.value.sessionId),
          streamId: String(planned.value.streamId),
          kind: "fork",
          atTurnId: null,
        },
      };
    },

    async rewind(sessionIdText, atTurnId, signal) {
      if (options.activation) {
        const selection = observed.get(sessionIdText);
        const result = await options.activation.activate(
          {
            kind: "rewind",
            sessionId: sessionIdText,
            ...(selection ? { observed: selection } : {}),
            atTurnId,
          },
          signal,
        );
        if (!result.ok) return { ok: false, error: navigationError(result.reason) };
        return {
          ok: true,
          value: {
            sessionId: result.sessionId,
            streamId: result.streamId,
            explanation: result.explanation,
            sourceSessionId: sessionIdText,
            kind: "rewind",
            atTurnId: atTurnId,
          },
        };
      }

      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const trimmed = atTurnId.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: { code: "empty" } };
      }
      const parsed = parseSessionId(sessionIdText);
      if (parsed === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      const suffix = crypto.randomUUID();
      const planned = rewindWorkspaceSession(
        options.sessions,
        options.turns,
        {
          sourceSessionId: parsed,
          identities: {
            sessionId: sessionId.from(`rewind-${suffix}`),
            streamId: streamId.from(`stream-rewind-${suffix}`),
            workspaceId,
          },
          edit: { kind: "rewind", atTurnId: trimmed },
        },
        signal,
      );
      if (!planned.ok) {
        return { ok: false, error: navigationError(planned.error.code) };
      }
      return {
        ok: true,
        value: {
          sourceSessionId: sessionIdText,
          sessionId: String(planned.value.sessionId),
          streamId: String(planned.value.streamId),
          kind: "rewind",
          atTurnId: trimmed,
        },
      };
    },

    async replay(sessionIdText, action, signal) {
      if (signal?.aborted === true) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsed = parseSessionId(sessionIdText);
      if (parsed === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      const controlled = await controlWorkspaceSessionReplay(
        options.sessions,
        options.events,
        {
          sessionId: parsed,
          command: { kind: action },
        },
        signal,
      );
      if (!controlled.ok) {
        return { ok: false, error: navigationError(controlled.error.code) };
      }
      return {
        ok: true,
        value: {
          sessionId: sessionIdText,
          status: controlled.value.status,
          atSequence:
            controlled.value.atSequence === null ? null : Number(controlled.value.atSequence),
          applied: controlled.value.applied,
          effectFree: true,
        },
      };
    },
  };
}
