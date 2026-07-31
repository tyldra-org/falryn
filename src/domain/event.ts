/**
 * The semantic event envelope.
 *
 * Every runtime event carries the same identity spine — event, stream,
 * sequence, kind, schema version, occurrence time, and correlation. Model
 * events add attempt identity and tool events add invocation and capability
 * identity, because those are the correlations their consumers cannot
 * reconstruct from the spine alone.
 *
 * The union is closed. An unknown kind is never widened into a known one; the
 * codec rejects it and preserves the observed string for quarantine.
 */

import type {
  CapabilityId,
  ConfigurationGeneration,
  EventId,
  IdempotencyKey,
  InvocationId,
  ModelAttemptId,
  Sequence,
  SessionId,
  StreamId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./identity.ts";
import type { TerminalOutcome } from "./outcome.ts";
import type { Timestamp } from "./time.ts";

export const EVENT_KINDS = [
  "session.started",
  "turn.started",
  "turn.completed",
  "model.attempt.started",
  "model.attempt.completed",
  "capability.invocation.started",
  "capability.invocation.completed",
  "configuration.generation.changed",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && (EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * How far a configuration change may propagate.
 *
 * A change never rewrites the generation an in-flight operation started with;
 * the class states when the new generation becomes observable instead.
 */
export const CONFIGURATION_APPLICATION_CLASSES = [
  "live",
  "next-operation",
  "next-turn",
  "reconnect",
  "application-restart",
] as const;

export type ConfigurationApplicationClass = (typeof CONFIGURATION_APPLICATION_CLASSES)[number];

/** Correlation available to every event in a session. */
export type SessionCorrelation = {
  readonly workspaceId: WorkspaceId;
  readonly sessionId: SessionId;
  readonly traceId: TraceId;
  readonly configurationGeneration: ConfigurationGeneration;
};

/** Correlation for work that belongs to one turn. */
export type TurnCorrelation = SessionCorrelation & {
  readonly turnId: TurnId;
};

/** A payload that carries no data of its own beyond the envelope. */
export type EmptyPayload = Record<string, never>;

export type TerminalPayload = {
  readonly outcome: TerminalOutcome;
};

export type ConfigurationGenerationChangedPayload = {
  readonly generation: ConfigurationGeneration;
  readonly applicationClass: ConfigurationApplicationClass;
};

type Envelope<Kind extends EventKind, Correlation, Payload> = {
  readonly eventId: EventId;
  /** The stream this event is sequenced within. Persists as `aggregateId`. */
  readonly streamId: StreamId;
  readonly sequence: Sequence;
  readonly kind: Kind;
  /** The version this event was written at. */
  readonly schemaVersion: number;
  /**
   * The lowest reader version able to interpret this event's required
   * semantics. A reader below it must reject rather than guess.
   */
  readonly minimumReaderSchemaVersion: number;
  readonly occurredAt: Timestamp;
  /** Makes a re-append after a retry a no-op instead of a second event. */
  readonly idempotencyKey: IdempotencyKey;
  readonly correlation: Correlation;
  readonly payload: Payload;
};

export type SessionStartedEvent = Envelope<"session.started", SessionCorrelation, EmptyPayload>;

export type TurnStartedEvent = Envelope<"turn.started", TurnCorrelation, EmptyPayload>;

export type TurnCompletedEvent = Envelope<"turn.completed", TurnCorrelation, TerminalPayload>;

export type ModelAttemptStartedEvent = Envelope<
  "model.attempt.started",
  TurnCorrelation,
  EmptyPayload
> & {
  readonly modelAttemptId: ModelAttemptId;
};

export type ModelAttemptCompletedEvent = Envelope<
  "model.attempt.completed",
  TurnCorrelation,
  TerminalPayload
> & {
  readonly modelAttemptId: ModelAttemptId;
};

export type CapabilityInvocationStartedEvent = Envelope<
  "capability.invocation.started",
  TurnCorrelation,
  EmptyPayload
> & {
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
};

export type CapabilityInvocationCompletedEvent = Envelope<
  "capability.invocation.completed",
  TurnCorrelation,
  TerminalPayload
> & {
  readonly invocationId: InvocationId;
  readonly capabilityId: CapabilityId;
};

export type ConfigurationGenerationChangedEvent = Envelope<
  "configuration.generation.changed",
  SessionCorrelation,
  ConfigurationGenerationChangedPayload
>;

export type RuntimeEvent =
  | SessionStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | ModelAttemptStartedEvent
  | ModelAttemptCompletedEvent
  | CapabilityInvocationStartedEvent
  | CapabilityInvocationCompletedEvent
  | ConfigurationGenerationChangedEvent;

export type ModelEvent = ModelAttemptStartedEvent | ModelAttemptCompletedEvent;

export type ToolEvent = CapabilityInvocationStartedEvent | CapabilityInvocationCompletedEvent;

export function isModelEvent(event: RuntimeEvent): event is ModelEvent {
  return event.kind === "model.attempt.started" || event.kind === "model.attempt.completed";
}

export function isToolEvent(event: RuntimeEvent): event is ToolEvent {
  return (
    event.kind === "capability.invocation.started" ||
    event.kind === "capability.invocation.completed"
  );
}

/**
 * A diagnostic view of an event.
 *
 * Deliberately excludes the payload. Runtime diagnostics report identity,
 * ordering, and size so a secret carried in a payload cannot reach a log,
 * metric, or support bundle through this path.
 */
export type EventSummary = {
  readonly eventId: EventId;
  readonly streamId: StreamId;
  readonly sequence: Sequence;
  readonly kind: EventKind;
  readonly schemaVersion: number;
  readonly occurredAt: Timestamp;
  readonly traceId: TraceId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId | null;
  readonly modelAttemptId: ModelAttemptId | null;
  readonly invocationId: InvocationId | null;
  readonly capabilityId: CapabilityId | null;
};

export function summarizeEvent(event: RuntimeEvent): EventSummary {
  return {
    eventId: event.eventId,
    streamId: event.streamId,
    sequence: event.sequence,
    kind: event.kind,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    traceId: event.correlation.traceId,
    sessionId: event.correlation.sessionId,
    turnId: "turnId" in event.correlation ? event.correlation.turnId : null,
    modelAttemptId: isModelEvent(event) ? event.modelAttemptId : null,
    invocationId: isToolEvent(event) ? event.invocationId : null,
    capabilityId: isToolEvent(event) ? event.capabilityId : null,
  };
}
