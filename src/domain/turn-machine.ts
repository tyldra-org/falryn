/**
 * Turn state machine with exhaustive terminal outcomes.
 *
 * Phases follow the unified-runtime coordinator diagram. Only named
 * transitions are legal. A terminal turn cannot receive model or capability
 * commands; resume is a recovery transition that starts a *new* runtime
 * generation without rewriting history to look uninterrupted.
 *
 * Cancellation during observation (any phase except executing-capability)
 * settles as `cancelled`. Cancellation while a capability may have mutated
 * the world settles as `uncertain` — never a bare `cancelled` — matching the
 * failure matrix in UNIFIED-RUNTIME.
 */

import type {
  ConfigurationGeneration,
  EventId,
  SessionId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./identity.ts";
import type { EffectCertainty, TerminalOutcome } from "./outcome.ts";
import { assertNever } from "./result.ts";

/** Schema version this build writes for turn-machine observations. */
export const TURN_MACHINE_SCHEMA_VERSION = 1;

export const TURN_PHASES = [
  "created",
  "orienting",
  "assembling-context",
  "awaiting-model",
  "handling-model-event",
  "executing-capability",
  "evaluating-completion",
] as const;

export type TurnPhase = (typeof TURN_PHASES)[number];

export function isTurnPhase(value: unknown): value is TurnPhase {
  return typeof value === "string" && (TURN_PHASES as readonly string[]).includes(value);
}

export const TURN_COMMANDS = [
  "begin-orienting",
  "begin-assembling-context",
  "begin-awaiting-model",
  "begin-handling-model-event",
  "begin-executing-capability",
  "begin-evaluating-completion",
  "cycle-to-model",
  "complete",
  "fail",
  "cancel",
  "time-out",
  "mark-uncertain",
  "recover",
] as const;

export type TurnCommand = (typeof TURN_COMMANDS)[number];

export type TurnTransitionError =
  | {
      readonly code: "illegal-transition";
      readonly phase: TurnPhase;
      readonly command: TurnCommand;
      readonly terminal: boolean;
    }
  | {
      readonly code: "already-terminal";
      readonly command: TurnCommand;
      readonly outcome: TerminalOutcome;
    }
  | {
      readonly code: "recovery-requires-interrupted";
      readonly terminal: boolean;
      readonly phase: TurnPhase;
    };

export type ActiveTurnSnapshot = {
  readonly status: "active";
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly traceId: TraceId;
  readonly phase: TurnPhase;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Generation this turn (or its latest recovery) started under. */
  readonly runtimeGeneration: ConfigurationGeneration;
  readonly observationOrder: number;
  readonly recordedEffect: EffectCertainty;
};

export type TerminalTurnSnapshot = {
  readonly status: "terminal";
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly traceId: TraceId;
  /** Last non-terminal phase before settlement. */
  readonly phase: TurnPhase;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly runtimeGeneration: ConfigurationGeneration;
  readonly observationOrder: number;
  readonly recordedEffect: EffectCertainty;
  readonly outcome: TerminalOutcome;
};

export type TurnSnapshot = ActiveTurnSnapshot | TerminalTurnSnapshot;

export type TurnObservation = {
  readonly schemaVersion: typeof TURN_MACHINE_SCHEMA_VERSION;
  readonly order: number;
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly from: TurnPhase;
  readonly to: TurnPhase;
  readonly command: TurnCommand;
  readonly terminal: boolean;
  readonly runtimeGeneration: ConfigurationGeneration;
  readonly causationEventId: EventId | null;
  readonly outcome: TerminalOutcome | null;
};

export type TurnTransitionResult =
  | {
      readonly kind: "transitioned";
      readonly snapshot: TurnSnapshot;
      readonly observation: TurnObservation;
    }
  | { readonly kind: "rejected"; readonly error: TurnTransitionError };

type PhaseEdge = {
  readonly command: TurnCommand;
  readonly to: TurnPhase;
};

/**
 * Non-terminal edges. Terminal commands are handled separately so every
 * TerminalOutcomeKind has exactly one settlement path.
 */
const PHASE_EDGES: Readonly<Record<TurnPhase, readonly PhaseEdge[]>> = {
  created: [{ command: "begin-orienting", to: "orienting" }],
  orienting: [{ command: "begin-assembling-context", to: "assembling-context" }],
  "assembling-context": [{ command: "begin-awaiting-model", to: "awaiting-model" }],
  "awaiting-model": [{ command: "begin-handling-model-event", to: "handling-model-event" }],
  "handling-model-event": [
    { command: "begin-executing-capability", to: "executing-capability" },
    { command: "begin-evaluating-completion", to: "evaluating-completion" },
  ],
  "executing-capability": [
    { command: "cycle-to-model", to: "awaiting-model" },
    { command: "begin-evaluating-completion", to: "evaluating-completion" },
  ],
  "evaluating-completion": [],
};

const TERMINAL_COMMANDS = new Set<TurnCommand>([
  "complete",
  "fail",
  "cancel",
  "time-out",
  "mark-uncertain",
]);

export function legalTurnCommands(snapshot: TurnSnapshot): readonly TurnCommand[] {
  if (snapshot.status === "terminal") {
    return ["recover"];
  }
  const phaseCommands = PHASE_EDGES[snapshot.phase].map((edge) => edge.command);
  if (snapshot.phase === "evaluating-completion") {
    return [...phaseCommands, "complete", "fail", "cancel", "time-out", "mark-uncertain"];
  }
  return [...phaseCommands, "cancel", "time-out", "mark-uncertain", "fail"];
}

export type ApplyTurnTransitionInput = {
  readonly snapshot: TurnSnapshot;
  readonly command: TurnCommand;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly causationEventId?: EventId | null;
  readonly effect?: EffectCertainty;
  /**
   * Required for `recover`: the generation the resumed turn runs under.
   * Must differ from the interrupted turn's runtime generation.
   */
  readonly recoveryGeneration?: ConfigurationGeneration;
};

function phaseTarget(phase: TurnPhase, command: TurnCommand): TurnPhase | null {
  for (const edge of PHASE_EDGES[phase]) {
    if (edge.command === command) {
      return edge.to;
    }
  }
  return null;
}

function outcomeFor(
  command: TurnCommand,
  phase: TurnPhase,
  effect: EffectCertainty,
): TerminalOutcome | null {
  switch (command) {
    case "complete":
      return { kind: "completed" };
    case "fail":
      return { kind: "failed", effect };
    case "cancel":
      // Mutation in flight cannot claim a clean cancel.
      if (phase === "executing-capability") {
        return { kind: "uncertain", effect: "uncertain" };
      }
      return { kind: "cancelled", effect };
    case "time-out":
      return { kind: "timed-out", effect };
    case "mark-uncertain":
      return { kind: "uncertain", effect: "uncertain" };
    case "begin-orienting":
    case "begin-assembling-context":
    case "begin-awaiting-model":
    case "begin-handling-model-event":
    case "begin-executing-capability":
    case "begin-evaluating-completion":
    case "cycle-to-model":
    case "recover":
      return null;
    default:
      return assertNever(command, "unhandled turn command");
  }
}

function mergeEffect(prior: EffectCertainty, next: EffectCertainty): EffectCertainty {
  const rank: Record<EffectCertainty, number> = {
    none: 0,
    completed: 1,
    partial: 2,
    uncertain: 3,
  };
  return rank[next] >= rank[prior] ? next : prior;
}

/**
 * Applies one named turn command.
 *
 * Recovery is the only command legal on a terminal snapshot: it produces a new
 * active snapshot at `orienting` under `recoveryGeneration`, leaving the
 * caller's retained terminal snapshot as history.
 */
export function applyTurnTransition(input: ApplyTurnTransitionInput): TurnTransitionResult {
  const { snapshot, command } = input;

  if (command === "recover") {
    return recoverTurn(input);
  }

  if (snapshot.status === "terminal") {
    return {
      kind: "rejected",
      error: {
        code: "already-terminal",
        command,
        outcome: snapshot.outcome,
      },
    };
  }

  if (TERMINAL_COMMANDS.has(command)) {
    return settleTurn(input, snapshot);
  }

  const to = phaseTarget(snapshot.phase, command);
  if (to === null) {
    return {
      kind: "rejected",
      error: {
        code: "illegal-transition",
        phase: snapshot.phase,
        command,
        terminal: false,
      },
    };
  }

  const order = snapshot.observationOrder + 1;
  const recordedEffect = mergeEffect(snapshot.recordedEffect, input.effect ?? "none");
  const next: ActiveTurnSnapshot = {
    ...snapshot,
    phase: to,
    configurationGeneration: input.configurationGeneration,
    observationOrder: order,
    recordedEffect,
  };

  return {
    kind: "transitioned",
    snapshot: next,
    observation: {
      schemaVersion: TURN_MACHINE_SCHEMA_VERSION,
      order,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      from: snapshot.phase,
      to,
      command,
      terminal: false,
      runtimeGeneration: snapshot.runtimeGeneration,
      causationEventId: input.causationEventId ?? null,
      outcome: null,
    },
  };
}

function settleTurn(
  input: ApplyTurnTransitionInput,
  snapshot: ActiveTurnSnapshot,
): TurnTransitionResult {
  const { command } = input;
  const effect = input.effect ?? snapshot.recordedEffect;
  const outcome = outcomeFor(command, snapshot.phase, effect);
  if (outcome === null) {
    return {
      kind: "rejected",
      error: {
        code: "illegal-transition",
        phase: snapshot.phase,
        command,
        terminal: false,
      },
    };
  }

  // Completion is only legal after evaluating-completion, and only when no
  // unresolved partial or uncertain effect remains to inspect.
  if (command === "complete") {
    if (snapshot.phase !== "evaluating-completion") {
      return {
        kind: "rejected",
        error: {
          code: "illegal-transition",
          phase: snapshot.phase,
          command,
          terminal: false,
        },
      };
    }
    if (snapshot.recordedEffect === "partial" || snapshot.recordedEffect === "uncertain") {
      return {
        kind: "rejected",
        error: {
          code: "illegal-transition",
          phase: snapshot.phase,
          command,
          terminal: false,
        },
      };
    }
  }

  const order = snapshot.observationOrder + 1;
  const recordedEffect =
    outcome.kind === "completed"
      ? "completed"
      : mergeEffect(snapshot.recordedEffect, effectOfOutcome(outcome));
  const next: TerminalTurnSnapshot = {
    status: "terminal",
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    workspaceId: snapshot.workspaceId,
    traceId: snapshot.traceId,
    phase: snapshot.phase,
    configurationGeneration: input.configurationGeneration,
    runtimeGeneration: snapshot.runtimeGeneration,
    observationOrder: order,
    recordedEffect,
    outcome,
  };

  return {
    kind: "transitioned",
    snapshot: next,
    observation: {
      schemaVersion: TURN_MACHINE_SCHEMA_VERSION,
      order,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      from: snapshot.phase,
      to: snapshot.phase,
      command,
      terminal: true,
      runtimeGeneration: snapshot.runtimeGeneration,
      causationEventId: input.causationEventId ?? null,
      outcome,
    },
  };
}

function recoverTurn(input: ApplyTurnTransitionInput): TurnTransitionResult {
  const { snapshot } = input;
  if (snapshot.status !== "terminal") {
    return {
      kind: "rejected",
      error: {
        code: "recovery-requires-interrupted",
        terminal: false,
        phase: snapshot.phase,
      },
    };
  }

  const recoveryGeneration = input.recoveryGeneration;
  if (recoveryGeneration === undefined || recoveryGeneration === snapshot.runtimeGeneration) {
    return {
      kind: "rejected",
      error: {
        code: "recovery-requires-interrupted",
        terminal: true,
        phase: snapshot.phase,
      },
    };
  }

  const order = snapshot.observationOrder + 1;
  const next: ActiveTurnSnapshot = {
    status: "active",
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    workspaceId: snapshot.workspaceId,
    traceId: snapshot.traceId,
    phase: "orienting",
    configurationGeneration: recoveryGeneration,
    runtimeGeneration: recoveryGeneration,
    observationOrder: order,
    recordedEffect: snapshot.recordedEffect,
  };

  return {
    kind: "transitioned",
    snapshot: next,
    observation: {
      schemaVersion: TURN_MACHINE_SCHEMA_VERSION,
      order,
      turnId: snapshot.turnId,
      sessionId: snapshot.sessionId,
      from: snapshot.phase,
      to: "orienting",
      command: "recover",
      terminal: false,
      runtimeGeneration: recoveryGeneration,
      causationEventId: input.causationEventId ?? null,
      outcome: null,
    },
  };
}

function effectOfOutcome(outcome: TerminalOutcome): EffectCertainty {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
    case "timed-out":
      return outcome.effect;
    case "uncertain":
      return "uncertain";
    default:
      return assertNever(outcome, "unhandled terminal outcome");
  }
}

export function createTurnSnapshot(input: {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly traceId: TraceId;
  readonly configurationGeneration: ConfigurationGeneration;
}): ActiveTurnSnapshot {
  return {
    status: "active",
    turnId: input.turnId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    traceId: input.traceId,
    phase: "created",
    configurationGeneration: input.configurationGeneration,
    runtimeGeneration: input.configurationGeneration,
    observationOrder: 0,
    recordedEffect: "none",
  };
}

/** Human label for diagnostics; exhaustive over {@link TurnPhase}. */
export function turnPhaseLabel(phase: TurnPhase): string {
  switch (phase) {
    case "created":
      return "created";
    case "orienting":
      return "orienting";
    case "assembling-context":
      return "assembling-context";
    case "awaiting-model":
      return "awaiting-model";
    case "handling-model-event":
      return "handling-model-event";
    case "executing-capability":
      return "executing-capability";
    case "evaluating-completion":
      return "evaluating-completion";
    default:
      return assertNever(phase, "unhandled turn phase");
  }
}
