/**
 * Turn lifecycle facts as durable runtime events, and pure replay of those
 * events into turn views.
 *
 * Application code appends facts through the existing {@link EventStorePort}.
 * Replay folds stored events only — it never calls a provider, tool runner,
 * filesystem, or network. Re-appending an identical idempotency key is a store
 * no-op, so retries do not create a second effect record.
 */

import type {
  CapabilityInvocationCompletedEvent,
  CapabilityInvocationStartedEvent,
  ExecutionProfileSelectedEvent,
  ModelAttemptBinding,
  ModelAttemptCompletedEvent,
  ModelAttemptStartedEvent,
  RuntimeEvent,
  SessionCorrelation,
  SessionStartedEvent,
  TurnCompletedEvent,
  TurnCorrelation,
  TurnStartedEvent,
} from "./event.ts";
import type { ExecutionProfileCompletion, ExecutionProfileId } from "./execution-profile.ts";
import {
  type CapabilityId,
  type EventId,
  eventId,
  type IdempotencyKey,
  type InvocationId,
  idempotencyKey,
  type ModelAttemptId,
  type Sequence,
  type StreamId,
  type TurnId,
} from "./identity.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./limits.ts";
import type { TerminalOutcome } from "./outcome.ts";
import { assertNever } from "./result.ts";
import type { ReplayReport } from "./sequence.ts";
import { inspectReplay } from "./sequence.ts";
import type { Timestamp } from "./time.ts";

/** One semantic fact the turn loop records. Effects are facts, never re-run. */
export type TurnLifecycleFact =
  | {
      readonly kind: "session.started";
      readonly correlation: SessionCorrelation;
    }
  | {
      readonly kind: "execution.profile.selected";
      readonly correlation: SessionCorrelation;
      readonly selectionId: string;
      readonly profileId: ExecutionProfileId;
      readonly profileVersion: 1;
      readonly completion: ExecutionProfileCompletion;
    }
  | {
      readonly kind: "turn.started";
      readonly correlation: TurnCorrelation;
    }
  | {
      readonly kind: "turn.completed";
      readonly correlation: TurnCorrelation;
      readonly outcome: TerminalOutcome;
    }
  | {
      readonly kind: "model.attempt.started";
      readonly correlation: TurnCorrelation;
      readonly modelAttemptId: ModelAttemptId;
      readonly binding?: ModelAttemptBinding;
    }
  | {
      readonly kind: "model.attempt.completed";
      readonly correlation: TurnCorrelation;
      readonly modelAttemptId: ModelAttemptId;
      readonly outcome: TerminalOutcome;
    }
  | {
      readonly kind: "capability.invocation.started";
      readonly correlation: TurnCorrelation;
      readonly invocationId: InvocationId;
      readonly capabilityId: CapabilityId;
    }
  | {
      readonly kind: "capability.invocation.completed";
      readonly correlation: TurnCorrelation;
      readonly invocationId: InvocationId;
      readonly capabilityId: CapabilityId;
      readonly outcome: TerminalOutcome;
    };

/**
 * Stable identity for one fact.
 *
 * The same key is both the event id and the idempotency key so a retry after an
 * ambiguous append is a duplicate receipt rather than a second event.
 */
export function factIdentity(fact: TurnLifecycleFact): string {
  switch (fact.kind) {
    case "session.started":
      return `session:${fact.correlation.sessionId}:started`;
    case "execution.profile.selected":
      return `session:${fact.correlation.sessionId}:profile:${fact.selectionId}`;
    case "turn.started":
      return `turn:${fact.correlation.turnId}:started`;
    case "turn.completed":
      return `turn:${fact.correlation.turnId}:completed`;
    case "model.attempt.started":
      return `attempt:${fact.modelAttemptId}:started`;
    case "model.attempt.completed":
      return `attempt:${fact.modelAttemptId}:completed`;
    case "capability.invocation.started":
      return `invocation:${fact.invocationId}:started`;
    case "capability.invocation.completed":
      return `invocation:${fact.invocationId}:completed`;
    default:
      return assertNever(fact, "unhandled turn lifecycle fact");
  }
}

export function eventIdForFact(fact: TurnLifecycleFact): EventId {
  return eventId.from(factIdentity(fact));
}

export function idempotencyKeyForFact(fact: TurnLifecycleFact): IdempotencyKey {
  return idempotencyKey.from(factIdentity(fact));
}

export type BuildTurnEventInput = {
  readonly fact: TurnLifecycleFact;
  readonly streamId: StreamId;
  readonly sequence: Sequence;
  readonly occurredAt: Timestamp;
};

/** Builds one runtime event from a lifecycle fact. Pure — no I/O. */
export function buildTurnLifecycleEvent(input: BuildTurnEventInput): RuntimeEvent {
  const identity = factIdentity(input.fact);
  const spine = {
    eventId: eventId.from(identity),
    streamId: input.streamId,
    sequence: input.sequence,
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    occurredAt: input.occurredAt,
    idempotencyKey: idempotencyKey.from(identity),
  };

  const fact = input.fact;
  switch (fact.kind) {
    case "session.started": {
      const event: SessionStartedEvent = {
        ...spine,
        kind: "session.started",
        correlation: fact.correlation,
        payload: {},
      };
      return event;
    }
    case "execution.profile.selected": {
      const event: ExecutionProfileSelectedEvent = {
        ...spine,
        kind: "execution.profile.selected",
        correlation: fact.correlation,
        payload: {
          selectionId: fact.selectionId,
          profileId: fact.profileId,
          profileVersion: fact.profileVersion,
          completion: fact.completion,
          applicationClass: "next-turn",
        },
      };
      return event;
    }
    case "turn.started": {
      const event: TurnStartedEvent = {
        ...spine,
        kind: "turn.started",
        correlation: fact.correlation,
        payload: {},
      };
      return event;
    }
    case "turn.completed": {
      const event: TurnCompletedEvent = {
        ...spine,
        kind: "turn.completed",
        correlation: fact.correlation,
        payload: { outcome: fact.outcome },
      };
      return event;
    }
    case "model.attempt.started": {
      const event: ModelAttemptStartedEvent = {
        ...spine,
        kind: "model.attempt.started",
        modelAttemptId: fact.modelAttemptId,
        correlation: fact.correlation,
        payload: fact.binding === undefined ? {} : { binding: fact.binding },
      };
      return event;
    }
    case "model.attempt.completed": {
      const event: ModelAttemptCompletedEvent = {
        ...spine,
        kind: "model.attempt.completed",
        modelAttemptId: fact.modelAttemptId,
        correlation: fact.correlation,
        payload: { outcome: fact.outcome },
      };
      return event;
    }
    case "capability.invocation.started": {
      const event: CapabilityInvocationStartedEvent = {
        ...spine,
        kind: "capability.invocation.started",
        invocationId: fact.invocationId,
        capabilityId: fact.capabilityId,
        correlation: fact.correlation,
        payload: {},
      };
      return event;
    }
    case "capability.invocation.completed": {
      const event: CapabilityInvocationCompletedEvent = {
        ...spine,
        kind: "capability.invocation.completed",
        invocationId: fact.invocationId,
        capabilityId: fact.capabilityId,
        correlation: fact.correlation,
        payload: { outcome: fact.outcome },
      };
      return event;
    }
    default:
      return assertNever(fact, "unhandled turn lifecycle fact");
  }
}

export type ReplayedAttempt = {
  readonly modelAttemptId: ModelAttemptId;
  readonly startedAt: Timestamp | null;
  readonly completedAt: Timestamp | null;
  readonly outcome: TerminalOutcome | null;
  readonly binding: ModelAttemptBinding | null;
};

export type ReplayedInvocation = {
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
  readonly startedAt: Timestamp | null;
  readonly completedAt: Timestamp | null;
  readonly outcome: TerminalOutcome | null;
};

/**
 * One turn rebuilt from stored events.
 *
 * Provider and tool *effects* are not re-executed: only the facts recorded in
 * the event stream appear here.
 */
export type ReplayedTurn = {
  readonly turnId: TurnId;
  readonly correlation: TurnCorrelation;
  readonly startedAt: Timestamp | null;
  readonly completedAt: Timestamp | null;
  readonly outcome: TerminalOutcome | null;
  readonly attempts: readonly ReplayedAttempt[];
  readonly invocations: readonly ReplayedInvocation[];
};

export type TurnEventReduction = {
  readonly sessionStarted: boolean;
  readonly sessionCorrelation: SessionCorrelation | null;
  readonly selectedExecutionProfile: ExecutionProfileId | null;
  readonly executionProfileSelections: readonly {
    readonly selectionId: string;
    readonly profileId: ExecutionProfileId;
    readonly profileVersion: 1;
    readonly completion: ExecutionProfileCompletion;
    readonly occurredAt: Timestamp;
  }[];
  readonly turns: readonly ReplayedTurn[];
};

type MutableAttempt = {
  modelAttemptId: ModelAttemptId;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  outcome: TerminalOutcome | null;
  binding: ModelAttemptBinding | null;
};

type MutableInvocation = {
  invocationId: InvocationId;
  capabilityId: CapabilityId;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  outcome: TerminalOutcome | null;
};

type MutableTurn = {
  turnId: TurnId;
  correlation: TurnCorrelation;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  outcome: TerminalOutcome | null;
  attempts: Map<ModelAttemptId, MutableAttempt>;
  attemptOrder: ModelAttemptId[];
  invocations: Map<InvocationId, MutableInvocation>;
  invocationOrder: InvocationId[];
};

/**
 * Pure fold of runtime events into turn views.
 *
 * Unknown kinds for this slice are ignored (configuration events share the
 * stream). The same events always produce the same reduction.
 */
export function reduceTurnEvents(events: readonly RuntimeEvent[]): TurnEventReduction {
  let sessionStarted = false;
  let sessionCorrelation: SessionCorrelation | null = null;
  let selectedExecutionProfile: ExecutionProfileId | null = null;
  const executionProfileSelections: Array<{
    selectionId: string;
    profileId: ExecutionProfileId;
    profileVersion: 1;
    completion: ExecutionProfileCompletion;
    occurredAt: Timestamp;
  }> = [];
  const turns = new Map<TurnId, MutableTurn>();
  const turnOrder: TurnId[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "session.started":
        sessionStarted = true;
        sessionCorrelation = event.correlation;
        break;
      case "execution.profile.selected":
        selectedExecutionProfile = event.payload.profileId;
        executionProfileSelections.push({
          selectionId: event.payload.selectionId,
          profileId: event.payload.profileId,
          profileVersion: event.payload.profileVersion,
          completion: event.payload.completion,
          occurredAt: event.occurredAt,
        });
        break;
      case "turn.started": {
        const id = event.correlation.turnId;
        let turn = turns.get(id);
        if (turn === undefined) {
          turn = emptyTurn(event.correlation);
          turns.set(id, turn);
          turnOrder.push(id);
        }
        turn.startedAt = event.occurredAt;
        turn.correlation = event.correlation;
        break;
      }
      case "turn.completed": {
        const id = event.correlation.turnId;
        let turn = turns.get(id);
        if (turn === undefined) {
          turn = emptyTurn(event.correlation);
          turns.set(id, turn);
          turnOrder.push(id);
        }
        turn.completedAt = event.occurredAt;
        turn.outcome = event.payload.outcome;
        turn.correlation = event.correlation;
        break;
      }
      case "model.attempt.started": {
        const turn = ensureTurn(turns, turnOrder, event.correlation);
        let attempt = turn.attempts.get(event.modelAttemptId);
        if (attempt === undefined) {
          attempt = {
            modelAttemptId: event.modelAttemptId,
            startedAt: null,
            completedAt: null,
            outcome: null,
            binding: null,
          };
          turn.attempts.set(event.modelAttemptId, attempt);
          turn.attemptOrder.push(event.modelAttemptId);
        }
        attempt.startedAt = event.occurredAt;
        attempt.binding = event.payload.binding ?? null;
        break;
      }
      case "model.attempt.completed": {
        const turn = ensureTurn(turns, turnOrder, event.correlation);
        let attempt = turn.attempts.get(event.modelAttemptId);
        if (attempt === undefined) {
          attempt = {
            modelAttemptId: event.modelAttemptId,
            startedAt: null,
            completedAt: null,
            outcome: null,
            binding: null,
          };
          turn.attempts.set(event.modelAttemptId, attempt);
          turn.attemptOrder.push(event.modelAttemptId);
        }
        attempt.completedAt = event.occurredAt;
        attempt.outcome = event.payload.outcome;
        break;
      }
      case "capability.invocation.started": {
        const turn = ensureTurn(turns, turnOrder, event.correlation);
        let invocation = turn.invocations.get(event.invocationId);
        if (invocation === undefined) {
          invocation = {
            invocationId: event.invocationId,
            capabilityId: event.capabilityId,
            startedAt: null,
            completedAt: null,
            outcome: null,
          };
          turn.invocations.set(event.invocationId, invocation);
          turn.invocationOrder.push(event.invocationId);
        }
        invocation.startedAt = event.occurredAt;
        invocation.capabilityId = event.capabilityId;
        break;
      }
      case "capability.invocation.completed": {
        const turn = ensureTurn(turns, turnOrder, event.correlation);
        let invocation = turn.invocations.get(event.invocationId);
        if (invocation === undefined) {
          invocation = {
            invocationId: event.invocationId,
            capabilityId: event.capabilityId,
            startedAt: null,
            completedAt: null,
            outcome: null,
          };
          turn.invocations.set(event.invocationId, invocation);
          turn.invocationOrder.push(event.invocationId);
        }
        invocation.completedAt = event.occurredAt;
        invocation.outcome = event.payload.outcome;
        invocation.capabilityId = event.capabilityId;
        break;
      }
      case "configuration.generation.changed":
        break;
      default:
        return assertNever(event, "unhandled runtime event kind");
    }
  }

  return {
    sessionStarted,
    sessionCorrelation,
    selectedExecutionProfile,
    executionProfileSelections,
    turns: turnOrder.flatMap((id) => {
      const turn = turns.get(id);
      return turn === undefined ? [] : [freezeTurn(turn)];
    }),
  };
}

function emptyTurn(correlation: TurnCorrelation): MutableTurn {
  return {
    turnId: correlation.turnId,
    correlation,
    startedAt: null,
    completedAt: null,
    outcome: null,
    attempts: new Map(),
    attemptOrder: [],
    invocations: new Map(),
    invocationOrder: [],
  };
}

function ensureTurn(
  turns: Map<TurnId, MutableTurn>,
  turnOrder: TurnId[],
  correlation: TurnCorrelation,
): MutableTurn {
  const existing = turns.get(correlation.turnId);
  if (existing !== undefined) {
    return existing;
  }
  const created = emptyTurn(correlation);
  turns.set(correlation.turnId, created);
  turnOrder.push(correlation.turnId);
  return created;
}

function freezeTurn(turn: MutableTurn): ReplayedTurn {
  return {
    turnId: turn.turnId,
    correlation: turn.correlation,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    outcome: turn.outcome,
    attempts: turn.attemptOrder.flatMap((id) => {
      const attempt = turn.attempts.get(id);
      return attempt === undefined
        ? []
        : [
            {
              modelAttemptId: attempt.modelAttemptId,
              startedAt: attempt.startedAt,
              completedAt: attempt.completedAt,
              outcome: attempt.outcome,
              binding: attempt.binding,
            },
          ];
    }),
    invocations: turn.invocationOrder.flatMap((id) => {
      const invocation = turn.invocations.get(id);
      return invocation === undefined
        ? []
        : [
            {
              invocationId: invocation.invocationId,
              capabilityId: invocation.capabilityId,
              startedAt: invocation.startedAt,
              completedAt: invocation.completedAt,
              outcome: invocation.outcome,
            },
          ];
    }),
  };
}

/**
 * Classifies a reduced stream after {@link inspectReplay}.
 *
 * Corrupt means the ordering rules observed an anomaly; the reduction is still
 * returned for diagnosis, and gaps are never closed.
 */
export type TurnReplayClassification =
  | {
      readonly kind: "rebuilt";
      readonly reduction: TurnEventReduction;
      readonly report: ReplayReport;
    }
  | {
      readonly kind: "empty";
      readonly report: ReplayReport;
    }
  | {
      readonly kind: "corrupt";
      readonly reduction: TurnEventReduction;
      readonly report: ReplayReport;
    };

export function classifyTurnReplay(events: readonly RuntimeEvent[]): TurnReplayClassification {
  const report = inspectReplay(events);
  const reduction = reduceTurnEvents(events);
  if (events.length === 0) {
    return { kind: "empty", report };
  }
  if (report.anomalies.length > 0) {
    return { kind: "corrupt", reduction, report };
  }
  return { kind: "rebuilt", reduction, report };
}
