/**
 * Deterministic fixtures for the runtime-event contracts.
 *
 * Test-only. Not re-exported from the domain entrypoint, and not imported by
 * product code. Every value is fixed — no clock, no randomness — so encoded
 * bytes are stable across runs and machines.
 */

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
} from "./foundation/identity.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "./foundation/limits.ts";
import { timestampFromEpochMilliseconds } from "./foundation/time.ts";
import type { TerminalOutcome } from "./orchestration/outcome.ts";
import { workQueueIdSchema } from "./orchestration/work-queue.ts";
import type {
  CapabilityInvocationCompletedEvent,
  CapabilityInvocationStartedEvent,
  ConfigurationGenerationChangedEvent,
  ExecutionProfileSelectedEvent,
  ModelAttemptCompletedEvent,
  ModelAttemptStartedEvent,
  ProcessTaskChangedEvent,
  RuntimeEvent,
  SessionCorrelation,
  SessionStartedEvent,
  TurnCompletedEvent,
  TurnCorrelation,
  TurnStartedEvent,
} from "./sessions/event.ts";
import type {
  InvocationRecord,
  ModelAttemptRecord,
  SessionRecord,
  TurnRecord,
} from "./sessions/records.ts";

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

export function executionProfileSelected(position = 9): ExecutionProfileSelectedEvent {
  return {
    ...spine({
      eventId: `event-profile-${position}`,
      sequence: position,
      idempotencyKey: `key-profile-${position}`,
    }),
    kind: "execution.profile.selected",
    correlation: FIXTURE_SESSION_CORRELATION,
    payload: {
      selectionId: `selection-${position}`,
      profileId: "agent",
      profileVersion: 1,
      completion: "implemented-and-verified",
      applicationClass: "next-turn",
    },
  };
}

export function processTaskChanged(position = 10): ProcessTaskChangedEvent {
  return {
    ...spine({
      eventId: `event-task-${position}`,
      sequence: position,
      idempotencyKey: `key-task-${position}`,
    }),
    kind: "process.task.changed",
    correlation: FIXTURE_TURN_CORRELATION,
    payload: {
      change: "created",
      task: {
        handle: { version: 1, taskId: "task-fixture", generation: "generation-fixture" },
        revision: 1,
        owner: {
          sessionId: FIXTURE_TURN_CORRELATION.sessionId,
          workspaceId: FIXTURE_TURN_CORRELATION.workspaceId,
          turnId: FIXTURE_TURN_CORRELATION.turnId,
          invocationId: "invocation-fixture",
          attemptId: "attempt-fixture",
          configurationGeneration: 0,
          resourceTaskId: "resource-fixture",
        },
        supervisor: {
          runId: "run-fixture",
          process: { platform: "linux", pid: 100, birth: "boot-fixture:1000" },
          leaseExpiresAt: 15_000,
        },
        attachment: "background",
        createdAt: 0,
        deadline: 30_000,
        inputDigest: "a".repeat(64),
        outputMode: "raw",
        state: "queued",
        process: null,
        terminal: null,
      },
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
    executionProfileSelected(9),
    processTaskChanged(10),
    {
      ...spine({
        eventId: "event-workspace-trust-11",
        sequence: 11,
        idempotencyKey: "key-workspace-trust-11",
      }),
      kind: "workspace.trust.reviewed",
      correlation: FIXTURE_SESSION_CORRELATION,
      payload: {
        version: 1,
        status: "refused",
        inventory: null,
        priorGeneration: null,
        reason: "project-loaders-disabled",
        added: 0,
        changed: 0,
        removed: 0,
      },
    },
    {
      ...spine({
        eventId: "event-work-queue-12",
        sequence: 12,
        idempotencyKey: "key-work-queue-12",
      }),
      kind: "work.queue.changed",
      correlation: FIXTURE_SESSION_CORRELATION,
      payload: {
        version: 1,
        queueId: workQueueIdSchema.parse("queue-fixture"),
        scopeGeneration: "scope-fixture",
        mutationId: "mutation-fixture",
        intent: "0".repeat(64),
        queueDigest: "1".repeat(64),
        edgesDigest: "2".repeat(64),
        previousRevision: 0,
        revision: 1,
        actor: "user-fixture",
        source: "prompt-fixture",
        sourceGeneration: "source-1",
        reason: "record work",
        at: 1,
        items: [],
      },
    },
    {
      ...spine({ eventId: "event-workflow-13", sequence: 13, idempotencyKey: "key-workflow-13" }),
      kind: "workflow.changed",
      correlation: FIXTURE_SESSION_CORRELATION,
      payload: {
        version: 1,
        handle: { id: "workflow-fixture", generation: "generation-1" },
        revision: 1,
        digest: `sha256:${"a".repeat(64)}`,
        definitionDigest: `sha256:${"b".repeat(64)}`,
        state: "admitted",
        at: 1,
      },
    },
    {
      ...spine({ eventId: "event-history-14", sequence: 14, idempotencyKey: "key-history-14" }),
      kind: "history.recorded",
      correlation: FIXTURE_TURN_CORRELATION,
      payload: {
        version: 1,
        id: "message-fixture",
        generation: 0,
        type: "message",
        messageId: "message-fixture",
        part: 0,
        role: "assistant",
        attemptId: "attempt-fixture",
        completion: "interrupted",
        relations: [],
        evidence: { availability: "unavailable", reason: "interrupted", fidelity: "unknown" },
      },
    },
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
