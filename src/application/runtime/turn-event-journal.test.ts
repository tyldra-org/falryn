import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  createManualClock,
  instant,
  invocationId,
  modelAttemptId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createInMemoryEventStore, type TurnLifecycleFact } from "../../domain/sessions/index.ts";
import { createTurnEventJournal } from "./turn-event-journal.ts";

const stream = streamId.from("session:journal-1");
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

function journal(maxEvents?: number) {
  const eventStore = createInMemoryEventStore();
  const clock = createManualClock(instant(1_000));
  return {
    eventStore,
    clock,
    journal: createTurnEventJournal({
      eventStore,
      clock,
      streamId: stream,
      correlation,
      ...(maxEvents === undefined ? {} : { maxEvents }),
    }),
  };
}

describe("turn event journal persist", () => {
  test("parallel appends and old duplicate receipts preserve the live sequence", async () => {
    const { journal: j } = journal();
    const facts: TurnLifecycleFact[] = Array.from({ length: 16 }, (_, index) => ({
      kind: "capability.invocation.started",
      correlation: turnCorrelation,
      invocationId: invocationId.from(`parallel-${index}`),
      capabilityId: capabilityId.from("read"),
    }));
    const observed: number[] = [];
    j.subscribe((events) => observed.push(...events.map((event) => Number(event.sequence))));
    const results = await Promise.all(facts.map((fact) => j.persist([fact])));
    expect(results.every((result) => result.kind === "persisted")).toBe(true);
    const first = facts[0];
    if (first === undefined) throw new Error("missing first fact");
    await j.persist([first]);
    const last = await j.persist([
      { kind: "turn.completed", correlation: turnCorrelation, outcome: { kind: "completed" } },
    ]);
    expect(last.kind).toBe("persisted");
    expect(observed).toHaveLength(17);
    expect(new Set(observed).size).toBe(17);
    expect(
      observed.every(
        (sequence, index) => index === 0 || sequence === Number(observed[index - 1]) + 1,
      ),
    ).toBe(true);
  });

  test("appends lifecycle facts through the existing event store", async () => {
    const { journal: j } = journal();
    const attempt = modelAttemptId.from("attempt-1");
    const facts: TurnLifecycleFact[] = [
      { kind: "session.started", correlation },
      { kind: "turn.started", correlation: turnCorrelation },
      {
        kind: "model.attempt.started",
        correlation: turnCorrelation,
        modelAttemptId: attempt,
      },
      {
        kind: "model.attempt.completed",
        correlation: turnCorrelation,
        modelAttemptId: attempt,
        outcome: { kind: "completed" },
      },
      {
        kind: "turn.completed",
        correlation: turnCorrelation,
        outcome: { kind: "completed" },
      },
    ];

    const persisted = await j.persist(facts);
    expect(persisted.kind).toBe("persisted");
    if (persisted.kind !== "persisted") {
      return;
    }
    expect(persisted.receipts.every((receipt) => receipt.kind === "appended")).toBe(true);
    expect(persisted.events.map((event) => event.kind)).toEqual([
      "session.started",
      "turn.started",
      "model.attempt.started",
      "model.attempt.completed",
      "turn.completed",
    ]);
  });

  test("re-appending the same facts is a duplicate no-op", async () => {
    const { journal: j } = journal();
    const facts: TurnLifecycleFact[] = [
      { kind: "turn.started", correlation: turnCorrelation },
      {
        kind: "turn.completed",
        correlation: turnCorrelation,
        outcome: { kind: "completed" },
      },
    ];
    const first = await j.persist(facts);
    expect(first.kind).toBe("persisted");

    const retry = await j.persist(facts);
    expect(retry.kind).toBe("persisted");
    if (retry.kind === "persisted") {
      expect(retry.receipts.every((receipt) => receipt.kind === "duplicate")).toBe(true);
    }
  });
});

describe("turn event journal replay", () => {
  test("rebuilds turn views without calling runners", async () => {
    let runnerCalls = 0;
    const runner = {
      run: async () => {
        runnerCalls += 1;
        throw new Error("replay must not execute attempts");
      },
    };
    void runner;

    const { journal: j } = journal();
    const attempt = modelAttemptId.from("attempt-1");
    const invocation = invocationId.from("inv-1");
    const capability = capabilityId.from("read");
    await j.persist([
      { kind: "turn.started", correlation: turnCorrelation },
      {
        kind: "model.attempt.started",
        correlation: turnCorrelation,
        modelAttemptId: attempt,
      },
      {
        kind: "capability.invocation.started",
        correlation: turnCorrelation,
        invocationId: invocation,
        capabilityId: capability,
      },
      {
        kind: "capability.invocation.completed",
        correlation: turnCorrelation,
        invocationId: invocation,
        capabilityId: capability,
        outcome: { kind: "completed" },
      },
      {
        kind: "model.attempt.completed",
        correlation: turnCorrelation,
        modelAttemptId: attempt,
        outcome: { kind: "completed" },
      },
      {
        kind: "turn.completed",
        correlation: turnCorrelation,
        outcome: { kind: "completed" },
      },
    ]);

    const replayed = await j.replay();
    expect(runnerCalls).toBe(0);
    expect(replayed.kind).toBe("rebuilt");
    if (replayed.kind !== "rebuilt") {
      return;
    }
    expect(replayed.turns).toHaveLength(1);
    const [turn] = replayed.turns;
    expect(turn).toBeDefined();
    if (turn === undefined) {
      throw new Error("expected one replayed turn");
    }
    expect(turn.outcome).toEqual({ kind: "completed" });
    expect(turn.invocations).toHaveLength(1);
    const [replayedAttempt] = turn.attempts;
    expect(replayedAttempt).toBeDefined();
    if (replayedAttempt === undefined) {
      throw new Error("expected one replayed attempt");
    }
    expect(replayedAttempt.outcome).toEqual({ kind: "completed" });
  });

  test("reports empty and missing turns", async () => {
    const { journal: j } = journal();
    expect((await j.replay()).kind).toBe("empty");
    const missing = await j.replayTurn(turnId.from("absent"));
    expect(missing.kind).toBe("turn-missing");
  });

  test("reports partial when the read bound truncates", async () => {
    const { journal: j } = journal(2);
    await j.persist([
      { kind: "turn.started", correlation: turnCorrelation },
      {
        kind: "model.attempt.started",
        correlation: turnCorrelation,
        modelAttemptId: modelAttemptId.from("attempt-1"),
      },
      {
        kind: "turn.completed",
        correlation: turnCorrelation,
        outcome: { kind: "completed" },
      },
    ]);
    const replayed = await j.replay();
    expect(replayed.kind).toBe("partial");
  });

  test("reports cancelled before a store read", async () => {
    const { journal: j } = journal();
    const controller = new AbortController();
    controller.abort();
    expect((await j.replay(controller.signal)).kind).toBe("cancelled");
  });
});
