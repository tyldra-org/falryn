import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  sessionId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { createTurnCoordinator } from "./turn-coordinator.ts";

const generation = configurationGeneration.from(0);
const recoveryGeneration = configurationGeneration.from(3);

describe("turn coordinator", () => {
  test("runs a turn to completion through the public boundary", () => {
    const coordinator = createTurnCoordinator();
    const started = coordinator.start({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      traceId: traceId.from("trace-1"),
      configurationGeneration: generation,
    });
    expect(started.ok).toBe(true);

    const commands = [
      "begin-orienting",
      "begin-assembling-context",
      "begin-awaiting-model",
      "begin-handling-model-event",
      "begin-evaluating-completion",
      "complete",
    ] as const;

    for (const command of commands) {
      const result = coordinator.apply({
        turnId: turnId.from("turn-1"),
        command,
        configurationGeneration: generation,
      });
      expect(result.ok).toBe(true);
    }

    expect(coordinator.get(turnId.from("turn-1"))).toMatchObject({
      status: "terminal",
      outcome: { kind: "completed" },
    });
    expect(coordinator.terminals(turnId.from("turn-1"))).toEqual([{ kind: "completed" }]);
  });

  test("recovers a terminal turn under a new generation", () => {
    const coordinator = createTurnCoordinator();
    coordinator.start({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      traceId: traceId.from("trace-1"),
      configurationGeneration: generation,
    });

    for (const command of [
      "begin-orienting",
      "begin-assembling-context",
      "begin-awaiting-model",
      "begin-handling-model-event",
      "begin-executing-capability",
      "cancel",
    ] as const) {
      expect(
        coordinator.apply({
          turnId: turnId.from("turn-1"),
          command,
          configurationGeneration: generation,
        }).ok,
      ).toBe(true);
    }

    expect(coordinator.terminals(turnId.from("turn-1"))).toEqual([
      { kind: "uncertain", effect: "uncertain" },
    ]);

    const recovered = coordinator.apply({
      turnId: turnId.from("turn-1"),
      command: "recover",
      configurationGeneration: recoveryGeneration,
      recoveryGeneration,
    });
    expect(recovered.ok).toBe(true);
    expect(coordinator.get(turnId.from("turn-1"))).toMatchObject({
      status: "active",
      phase: "orienting",
      runtimeGeneration: recoveryGeneration,
    });
  });

  test("rejects duplicate start and unknown turns", () => {
    const coordinator = createTurnCoordinator();
    const input = {
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      traceId: traceId.from("trace-1"),
      configurationGeneration: generation,
    };
    expect(coordinator.start(input).ok).toBe(true);
    expect(coordinator.start(input)).toEqual({
      ok: false,
      error: { code: "turn-already-exists", turnId: turnId.from("turn-1") },
    });
    expect(
      coordinator.apply({
        turnId: turnId.from("missing"),
        command: "begin-orienting",
        configurationGeneration: generation,
      }),
    ).toEqual({
      ok: false,
      error: { code: "turn-not-found", turnId: turnId.from("missing") },
    });
  });
});
