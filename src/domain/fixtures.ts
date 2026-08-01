/**
 * Deterministic fixtures for the runtime-event contracts.
 *
 * Test-only. Not re-exported from the domain entrypoint, and not imported by
 * product code. Every value is fixed — no clock, no randomness — so encoded
 * bytes are stable across runs and machines.
 */

import type {
  CapabilityInvocationCompletedEvent,
  CapabilityInvocationStartedEvent,
  ConfigurationGenerationChangedEvent,
  ModelAttemptCompletedEvent,
  ModelAttemptStartedEvent,
  RuntimeEvent,
  SessionCorrelation,
  SessionStartedEvent,
  TurnCompletedEvent,
  TurnCorrelation,
  TurnStartedEvent,
} from "./event.ts";
import {
  capabilityId,
  configurationGeneration,
  eventId,
  idempotencyKey,
  invocationId,
  modelAttemptId,
  modelId,
  providerId,
  sequence,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "./identity.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./limits.ts";
import type { TerminalOutcome } from "./outcome.ts";
import type { InvocationRecord, ModelAttemptRecord, SessionRecord, TurnRecord } from "./records.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

export const FIXTURE_OCCURRED_AT = timestampFromEpochMilliseconds(Date.UTC(2026, 6, 31, 12, 0, 0));

export const FIXTURE_STREAM = streamId.from("session:fixture-session");
export const FIXTURE_OTHER_STREAM = streamId.from("session:other-session");

export const FIXTURE_SESSION_CORRELATION: SessionCorrelation = {
  workspaceId: workspaceId.from("workspace-fixture"),
  sessionId: sessionId.from("session-fixture"),
  traceId: traceId.from("trace-fixture"),
  configurationGeneration: configurationGeneration.from(0),
};

export const FIXTURE_TURN_CORRELATION: TurnCorrelation = {
  ...FIXTURE_SESSION_CORRELATION,
  turnId: turnId.from("turn-fixture"),
};

type Spine = {
  readonly eventId: string;
  readonly sequence: number;
  readonly idempotencyKey: string;
};

function spine({ eventId: id, sequence: position, idempotencyKey: key }: Spine) {
  return {
    eventId: eventId.from(id),
    streamId: FIXTURE_STREAM,
    sequence: sequence.from(position),
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    occurredAt: FIXTURE_OCCURRED_AT,
    idempotencyKey: idempotencyKey.from(key),
  };
}

export function sessionStarted(position = 1): SessionStartedEvent {
  return {
    ...spine({
      eventId: `event-session-${position}`,
      sequence: position,
      idempotencyKey: `key-session-${position}`,
    }),
    kind: "session.started",
    correlation: FIXTURE_SESSION_CORRELATION,
    payload: {},
  };
}

export function turnStarted(position = 2): TurnStartedEvent {
  return {
    ...spine({
      eventId: `event-turn-start-${position}`,
      sequence: position,
      idempotencyKey: `key-turn-start-${position}`,
    }),
    kind: "turn.started",
    correlation: FIXTURE_TURN_CORRELATION,
    payload: {},
  };
}

export function turnCompleted(
  position = 3,
  outcome: TerminalOutcome = { kind: "completed" },
): TurnCompletedEvent {
  return {
    ...spine({
      eventId: `event-turn-done-${position}`,
      sequence: position,
      idempotencyKey: `key-turn-done-${position}`,
    }),
    kind: "turn.completed",
    correlation: FIXTURE_TURN_CORRELATION,
    payload: { outcome },
  };
}

export function modelAttemptStarted(position = 4): ModelAttemptStartedEvent {
  return {
    ...spine({
      eventId: `event-attempt-start-${position}`,
      sequence: position,
      idempotencyKey: `key-attempt-start-${position}`,
    }),
    kind: "model.attempt.started",
    modelAttemptId: modelAttemptId.from("attempt-fixture"),
    correlation: FIXTURE_TURN_CORRELATION,
    payload: {},
  };
}

export function modelAttemptCompleted(
  position = 5,
  outcome: TerminalOutcome = { kind: "failed", effect: "none" },
): ModelAttemptCompletedEvent {
  return {
    ...spine({
      eventId: `event-attempt-done-${position}`,
      sequence: position,
      idempotencyKey: `key-attempt-done-${position}`,
    }),
    kind: "model.attempt.completed",
    modelAttemptId: modelAttemptId.from("attempt-fixture"),
    correlation: FIXTURE_TURN_CORRELATION,
    payload: { outcome },
  };
}

export function capabilityInvocationStarted(position = 6): CapabilityInvocationStartedEvent {
  return {
    ...spine({
      eventId: `event-invocation-start-${position}`,
      sequence: position,
      idempotencyKey: `key-invocation-start-${position}`,
    }),
    kind: "capability.invocation.started",
    invocationId: invocationId.from("invocation-fixture"),
    capabilityId: capabilityId.from("workspace.read"),
    correlation: FIXTURE_TURN_CORRELATION,
    payload: {},
  };
}

export function capabilityInvocationCompleted(
  position = 7,
  outcome: TerminalOutcome = { kind: "uncertain", effect: "uncertain" },
): CapabilityInvocationCompletedEvent {
  return {
    ...spine({
      eventId: `event-invocation-done-${position}`,
      sequence: position,
      idempotencyKey: `key-invocation-done-${position}`,
    }),
    kind: "capability.invocation.completed",
    invocationId: invocationId.from("invocation-fixture"),
    capabilityId: capabilityId.from("workspace.read"),
    correlation: FIXTURE_TURN_CORRELATION,
    payload: { outcome },
  };
}

export function configurationGenerationChanged(position = 8): ConfigurationGenerationChangedEvent {
  return {
    ...spine({
      eventId: `event-config-${position}`,
      sequence: position,
      idempotencyKey: `key-config-${position}`,
    }),
    kind: "configuration.generation.changed",
    correlation: FIXTURE_SESSION_CORRELATION,
    payload: {
      generation: configurationGeneration.from(1),
      applicationClass: "next-turn",
    },
  };
}

/** One valid event per declared kind, already in stream order. */
export function everyEventKind(): readonly RuntimeEvent[] {
  return [
    sessionStarted(1),
    turnStarted(2),
    turnCompleted(3),
    modelAttemptStarted(4),
    modelAttemptCompleted(5),
    capabilityInvocationStarted(6),
    capabilityInvocationCompleted(7),
    configurationGenerationChanged(8),
  ];
}

/** Places a fixture event on a second stream so isolation can be observed. */
export function onOtherStream<Event extends RuntimeEvent>(event: Event): Event {
  return { ...event, streamId: FIXTURE_OTHER_STREAM };
}

/**
 * Durable records matching the fixture events above.
 *
 * Deliberately the same identities: the events describe the lifecycle of these
 * exact records, which is what lets a projection test apply
 * {@link everyEventKind} to them and check the result rather than inventing a
 * second, unrelated set of identifiers.
 */
export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: FIXTURE_SESSION_CORRELATION.sessionId,
    workspaceId: FIXTURE_SESSION_CORRELATION.workspaceId,
    streamId: FIXTURE_STREAM,
    title: "fixture session",
    configurationGeneration: FIXTURE_SESSION_CORRELATION.configurationGeneration,
    startedAt: FIXTURE_OCCURRED_AT,
    closedAt: null,
    outcome: null,
    ...overrides,
  };
}

export function turnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: FIXTURE_TURN_CORRELATION.turnId,
    sessionId: FIXTURE_SESSION_CORRELATION.sessionId,
    parentTurnId: null,
    startedAt: FIXTURE_OCCURRED_AT,
    completedAt: null,
    outcome: null,
    ...overrides,
  };
}

export function modelAttemptRecord(
  overrides: Partial<ModelAttemptRecord> = {},
): ModelAttemptRecord {
  return {
    modelAttemptId: modelAttemptId.from("attempt-fixture"),
    turnId: FIXTURE_TURN_CORRELATION.turnId,
    providerId: providerId.from("provider-fixture"),
    modelId: modelId.from("model-fixture"),
    startedAt: FIXTURE_OCCURRED_AT,
    completedAt: null,
    outcome: null,
    ...overrides,
  };
}

export function invocationRecord(overrides: Partial<InvocationRecord> = {}): InvocationRecord {
  return {
    invocationId: invocationId.from("invocation-fixture"),
    turnId: FIXTURE_TURN_CORRELATION.turnId,
    capabilityId: capabilityId.from("workspace.read"),
    capabilityVersion: 1,
    inputDigest: "0f1e2d3c4b5a6978",
    startedAt: FIXTURE_OCCURRED_AT,
    completedAt: null,
    outcome: null,
    ...overrides,
  };
}
