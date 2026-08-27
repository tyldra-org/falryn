import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  eventId,
  invocationId,
  modelAttemptId,
  sequence,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "./identity.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";
import {
  buildTurnLifecycleEvent,
  classifyTurnReplay,
  factIdentity,
  reduceTurnEvents,
  type TurnLifecycleFact,
} from "./turn-events.ts";

const occurredAt = timestampFromEpochMilliseconds(Date.UTC(2026, 7, 12, 12, 0, 0));
const stream = streamId.from("session:turn-events");
const correlation = {
  workspaceId: workspaceId.from("workspace-1"),
  sessionId: sessionId.from("session-1"),
  traceId: traceId.from("trace-1"),
  configurationGeneration: configurationGeneration.from(0),
};
const turnCorrelation = {
  ...correlation,
  turnId: turnId.from("turn-1"),
};

function eventAt(fact: TurnLifecycleFact, position: number) {
  return buildTurnLifecycleEvent({
    fact,
    streamId: stream,
    sequence: sequence.from(position),
    occurredAt,
  });
}

describe("turn lifecycle fact identity", () => {
  test("is stable for retries", () => {
    const fact: TurnLifecycleFact = {
      kind: "turn.started",
      correlation: turnCorrelation,
    };
    expect(factIdentity(fact)).toBe("turn:turn-1:started");
    expect(
      buildTurnLifecycleEvent({
        fact,
        streamId: stream,
        sequence: sequence.from(1),
        occurredAt,
      }).eventId,
    ).toEqual(eventId.from("turn:turn-1:started"));
  });
});

describe("reduceTurnEvents", () => {
  test("replays session profile transitions without re-executing work", () => {
    const events = [
      eventAt({ kind: "session.started", correlation }, 1),
      eventAt(
        {
          kind: "execution.profile.selected",
          correlation,
          selectionId: "profile-1",
          profileId: "ask",
          profileVersion: 1,
          completion: "answer",
        },
        2,
      ),
      eventAt(
        {
          kind: "execution.profile.selected",
          correlation,
          selectionId: "profile-2",
          profileId: "debug",
          profileVersion: 1,
          completion: "diagnosis",
        },
        3,
      ),
    ];

    const reduction = reduceTurnEvents(events);
    expect(reduction.selectedExecutionProfile).toBe("debug");
    expect(reduction.executionProfileSelections.map((selection) => selection.profileId)).toEqual([
      "ask",
      "debug",
    ]);
    expect(classifyTurnReplay(events).kind).toBe("rebuilt");
  });

  test("rebuilds a turn with attempt and invocation facts", () => {
    const attempt = modelAttemptId.from("attempt-1");
    const invocation = invocationId.from("inv-1");
    const capability = capabilityId.from("read");
    const events = [
      eventAt({ kind: "session.started", correlation }, 1),
      eventAt({ kind: "turn.started", correlation: turnCorrelation }, 2),
      eventAt(
        {
          kind: "model.attempt.started",
          correlation: turnCorrelation,
          modelAttemptId: attempt,
        },
        3,
      ),
      eventAt(
        {
          kind: "capability.invocation.started",
          correlation: turnCorrelation,
          invocationId: invocation,
          capabilityId: capability,
        },
        4,
      ),
      eventAt(
        {
          kind: "capability.invocation.completed",
          correlation: turnCorrelation,
          invocationId: invocation,
          capabilityId: capability,
          outcome: { kind: "completed" },
        },
        5,
      ),
      eventAt(
        {
          kind: "model.attempt.completed",
          correlation: turnCorrelation,
          modelAttemptId: attempt,
          outcome: { kind: "completed" },
        },
        6,
      ),
      eventAt(
        {
          kind: "turn.completed",
          correlation: turnCorrelation,
          outcome: { kind: "completed" },
        },
        7,
      ),
    ];

    const reduction = reduceTurnEvents(events);
    expect(reduction.sessionStarted).toBe(true);
    expect(reduction.turns).toHaveLength(1);
    const [turn] = reduction.turns;
    expect(turn).toBeDefined();
    if (turn === undefined) {
      throw new Error("expected one reduced turn");
    }
    expect(turn.turnId).toBe(turnCorrelation.turnId);
    expect(turn.outcome).toEqual({ kind: "completed" });
    expect(turn.attempts).toEqual([
      {
        modelAttemptId: attempt,
        startedAt: occurredAt,
        completedAt: occurredAt,
        outcome: { kind: "completed" },
        binding: null,
      },
    ]);
    expect(turn.invocations).toEqual([
      {
        invocationId: invocation,
        capabilityId: capability,
        startedAt: occurredAt,
        completedAt: occurredAt,
        outcome: { kind: "completed" },
      },
    ]);
  });

  test("is identical when folded twice", () => {
    const events = [
      eventAt({ kind: "turn.started", correlation: turnCorrelation }, 1),
      eventAt(
        {
          kind: "turn.completed",
          correlation: turnCorrelation,
          outcome: { kind: "failed", effect: "none" },
        },
        2,
      ),
    ];
    expect(reduceTurnEvents(events)).toEqual(reduceTurnEvents(events));
  });
});

describe("classifyTurnReplay", () => {
  test("reports empty streams", () => {
    expect(classifyTurnReplay([]).kind).toBe("empty");
  });

  test("reports corrupt streams with sequence gaps", () => {
    const events = [
      eventAt({ kind: "turn.started", correlation: turnCorrelation }, 1),
      eventAt(
        {
          kind: "turn.completed",
          correlation: turnCorrelation,
          outcome: { kind: "completed" },
        },
        3,
      ),
    ];
    const classified = classifyTurnReplay(events);
    expect(classified.kind).toBe("corrupt");
    if (classified.kind === "corrupt") {
      expect(classified.report.anomalies.length).toBeGreaterThan(0);
      expect(classified.reduction.turns).toHaveLength(1);
    }
  });

  test("rebuilds a clean stream", () => {
    const events = [
      eventAt({ kind: "turn.started", correlation: turnCorrelation }, 1),
      eventAt(
        {
          kind: "turn.completed",
          correlation: turnCorrelation,
          outcome: { kind: "cancelled", effect: "none" },
        },
        2,
      ),
    ];
    const classified = classifyTurnReplay(events);
    expect(classified.kind).toBe("rebuilt");
  });
});
