/**
 * Session lifecycle phases and legal transitions.
 *
 * The session is the long-lived root for turns. Its phases match the unified
 * runtime lifecycle diagram: bootstrap opens trusted local state, ready waits
 * for work, active-turn means exactly one turn is in flight, recovering is the
 * observable path back from interrupted state, draining is cooperative close,
 * and closed is terminal.
 *
 * Only named transitions are legal. A closed session cannot reopen; a new
 * session identity is required instead. Ready and active-turn are the phases
 * this module finally makes enforceable — earlier runtime work stopped at
 * draining and closed through the scope tree alone.
 */

import type { ConfigurationGeneration, EventId, SessionId, WorkspaceId } from "./identity.ts";
import type { TerminalOutcome } from "./outcome.ts";
import { assertNever } from "./result.ts";

/** Schema version this build writes for session-lifecycle observations. */
export const SESSION_LIFECYCLE_SCHEMA_VERSION = 1;

export const SESSION_PHASES = [
  "bootstrap",
  "ready",
  "active-turn",
  "recovering",
  "draining",
  "closed",
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

export function isSessionPhase(value: unknown): value is SessionPhase {
  return typeof value === "string" && (SESSION_PHASES as readonly string[]).includes(value);
}

/** Whether the phase may accept further transitions. */
export function isSessionTerminalPhase(phase: SessionPhase): boolean {
  return phase === "closed";
}

/**
 * Named commands that move a session between phases.
 *
 * Commands are deliberate — there is no inferred transition from wall-clock or
 * from a turn ending without the session being told.
 */
export const SESSION_COMMANDS = [
  "mark-ready",
  "begin-turn",
  "end-turn",
  "begin-recovery",
  "finish-recovery",
  "begin-drain",
  "close",
] as const;

export type SessionCommand = (typeof SESSION_COMMANDS)[number];

export type SessionTransitionError =
  | {
      readonly code: "illegal-transition";
      readonly phase: SessionPhase;
      readonly command: SessionCommand;
    }
  | {
      readonly code: "already-closed";
      readonly command: SessionCommand;
    }
  | {
      readonly code: "active-turn-required";
      readonly phase: SessionPhase;
      readonly command: SessionCommand;
    };

export type SessionSnapshot = {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly phase: SessionPhase;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Generation the session entered its current phase under. */
  readonly phaseGeneration: ConfigurationGeneration;
  readonly outcome: TerminalOutcome | null;
  /** In-process observation order; not a durable stream sequence. */
  readonly observationOrder: number;
};

export type SessionObservation = {
  readonly schemaVersion: typeof SESSION_LIFECYCLE_SCHEMA_VERSION;
  readonly order: number;
  readonly sessionId: SessionId;
  readonly from: SessionPhase;
  readonly to: SessionPhase;
  readonly command: SessionCommand;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Prior observation that caused this one, when known. */
  readonly causationEventId: EventId | null;
  readonly outcome: TerminalOutcome | null;
};

export type SessionTransitionResult =
  | {
      readonly kind: "transitioned";
      readonly snapshot: SessionSnapshot;
      readonly observation: SessionObservation;
    }
  | { readonly kind: "rejected"; readonly error: SessionTransitionError };

type Edge = {
  readonly command: SessionCommand;
  readonly to: SessionPhase;
};

/**
 * The closed transition table.
 *
 * `end-turn` returns to ready only from active-turn. `begin-recovery` is legal
 * from ready or active-turn so an interrupted turn or a resume-before-turn path
 * both land in the same recovering phase. Closing always drains first — there
 * is no direct jump to closed from an active phase.
 */
const EDGES: Readonly<Record<SessionPhase, readonly Edge[]>> = {
  bootstrap: [{ command: "mark-ready", to: "ready" }],
  ready: [
    { command: "begin-turn", to: "active-turn" },
    { command: "begin-recovery", to: "recovering" },
    { command: "begin-drain", to: "draining" },
  ],
  "active-turn": [
    { command: "end-turn", to: "ready" },
    { command: "begin-recovery", to: "recovering" },
    { command: "begin-drain", to: "draining" },
  ],
  recovering: [
    { command: "finish-recovery", to: "ready" },
    { command: "begin-drain", to: "draining" },
  ],
  draining: [{ command: "close", to: "closed" }],
  closed: [],
};

export function legalSessionCommands(phase: SessionPhase): readonly SessionCommand[] {
  return EDGES[phase].map((edge) => edge.command);
}

function targetPhase(phase: SessionPhase, command: SessionCommand): SessionPhase | null {
  for (const edge of EDGES[phase]) {
    if (edge.command === command) {
      return edge.to;
    }
  }
  return null;
}

export type ApplySessionTransitionInput = {
  readonly snapshot: SessionSnapshot;
  readonly command: SessionCommand;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly causationEventId?: EventId | null;
  readonly outcome?: TerminalOutcome | null;
};

/**
 * Applies one named session command.
 *
 * Pure: the caller owns persistence and identity allocation. Closing may carry
 * a terminal outcome; every other transition leaves the prior outcome untouched
 * unless the caller supplies a replacement.
 */
export function applySessionTransition(
  input: ApplySessionTransitionInput,
): SessionTransitionResult {
  const { snapshot, command } = input;

  if (snapshot.phase === "closed") {
    return {
      kind: "rejected",
      error: { code: "already-closed", command },
    };
  }

  const to = targetPhase(snapshot.phase, command);
  if (to === null) {
    return {
      kind: "rejected",
      error: { code: "illegal-transition", phase: snapshot.phase, command },
    };
  }

  if (command === "end-turn" && snapshot.phase !== "active-turn") {
    return {
      kind: "rejected",
      error: {
        code: "active-turn-required",
        phase: snapshot.phase,
        command,
      },
    };
  }

  const outcome =
    command === "close"
      ? (input.outcome ?? snapshot.outcome ?? { kind: "completed" })
      : (input.outcome ?? snapshot.outcome);

  const order = snapshot.observationOrder + 1;
  const next: SessionSnapshot = {
    sessionId: snapshot.sessionId,
    workspaceId: snapshot.workspaceId,
    phase: to,
    configurationGeneration: input.configurationGeneration,
    phaseGeneration: input.configurationGeneration,
    outcome,
    observationOrder: order,
  };

  return {
    kind: "transitioned",
    snapshot: next,
    observation: {
      schemaVersion: SESSION_LIFECYCLE_SCHEMA_VERSION,
      order,
      sessionId: snapshot.sessionId,
      from: snapshot.phase,
      to,
      command,
      configurationGeneration: input.configurationGeneration,
      causationEventId: input.causationEventId ?? null,
      outcome,
    },
  };
}

export function createSessionSnapshot(input: {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly configurationGeneration: ConfigurationGeneration;
}): SessionSnapshot {
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    phase: "bootstrap",
    configurationGeneration: input.configurationGeneration,
    phaseGeneration: input.configurationGeneration,
    outcome: null,
    observationOrder: 0,
  };
}

/** Human label for diagnostics; exhaustive over {@link SessionPhase}. */
export function sessionPhaseLabel(phase: SessionPhase): string {
  switch (phase) {
    case "bootstrap":
      return "bootstrap";
    case "ready":
      return "ready";
    case "active-turn":
      return "active-turn";
    case "recovering":
      return "recovering";
    case "draining":
      return "draining";
    case "closed":
      return "closed";
    default:
      return assertNever(phase, "unhandled session phase");
  }
}
