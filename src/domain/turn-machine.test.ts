import { describe, expect, test } from "bun:test";
import type { TerminalOutcome, TurnCommand, TurnSnapshot } from "./index.ts";
import {
  applyTurnTransition,
  configurationGeneration,
  createTurnSnapshot,
  isTurnPhase,
  legalTurnCommands,
  sessionId,
  TURN_COMMANDS,
  TURN_MACHINE_SCHEMA_VERSION,
  TURN_PHASES,
  traceId,
  turnId,
  turnPhaseLabel,
  workspaceId,
} from "./index.ts";
import { assertNever } from "./result.ts";

const generation = configurationGeneration.from(0);
const recoveryGeneration = configurationGeneration.from(2);

function start(): TurnSnapshot {
  return createTurnSnapshot({
    turnId: turnId.from("turn-1"),
    sessionId: sessionId.from("session-1"),
    workspaceId: workspaceId.from("workspace-1"),
    traceId: traceId.from("trace-1"),
    configurationGeneration: generation,
  });
}

function apply(snapshot: TurnSnapshot, command: TurnCommand, effect?: "none" | "partial") {
  const result = applyTurnTransition({
    snapshot,
    command,
    configurationGeneration: generation,
    ...(effect === undefined ? {} : { effect }),
  });
  expect(result.kind).toBe("transitioned");
  if (result.kind !== "transitioned") {
    throw new Error(`expected ${command} to transition`);
  }
  return result.snapshot;
}

function happyPathTo(phase: (typeof TURN_PHASES)[number]): TurnSnapshot {
  let current = start();
  const steps: TurnCommand[] = [
    "begin-orienting",
    "begin-assembling-context",
    "begin-awaiting-model",
    "begin-handling-model-event",
  ];
  for (const command of steps) {
    current = apply(current, command);
    if (current.status === "active" && current.phase === phase) {
      return current;
    }
  }
  if (phase === "executing-capability") {
    return apply(current, "begin-executing-capability");
  }
  if (phase === "evaluating-completion") {
    return apply(current, "begin-evaluating-completion");
  }
  return current;
}

describe("turn state machine", () => {
  test("declares every phase and labels them exhaustively", () => {
    expect([...TURN_PHASES]).toEqual([
      "created",
      "orienting",
      "assembling-context",
      "awaiting-model",
      "handling-model-event",
      "executing-capability",
      "evaluating-completion",
    ]);
    for (const phase of TURN_PHASES) {
      expect(isTurnPhase(phase)).toBe(true);
      expect(turnPhaseLabel(phase).length).toBeGreaterThan(0);
    }
    expect(isTurnPhase("accepted")).toBe(false);
  });

  test("walks the coordinator path including a capability cycle", () => {
    let current = happyPathTo("handling-model-event");
    current = apply(current, "begin-executing-capability");
    expect(current).toMatchObject({
      status: "active",
      phase: "executing-capability",
      recordedEffect: "none",
    });
    current = apply(current, "cycle-to-model");
    expect(current).toMatchObject({ status: "active", phase: "awaiting-model" });
    current = apply(current, "begin-handling-model-event");
    current = apply(current, "begin-evaluating-completion");
    const completed = applyTurnTransition({
      snapshot: current,
      command: "complete",
      configurationGeneration: generation,
    });
    expect(completed).toMatchObject({
      kind: "transitioned",
      snapshot: {
        status: "terminal",
        outcome: { kind: "completed" },
        recordedEffect: "completed",
      },
      observation: {
        schemaVersion: TURN_MACHINE_SCHEMA_VERSION,
        terminal: true,
      },
    });
  });

  test("refuses completed settlement while a partial effect remains", () => {
    let current = happyPathTo("handling-model-event");
    current = apply(current, "begin-executing-capability", "partial");
    current = apply(current, "begin-evaluating-completion");
    expect(
      applyTurnTransition({
        snapshot: current,
        command: "complete",
        configurationGeneration: generation,
      }),
    ).toMatchObject({
      kind: "rejected",
      error: { code: "illegal-transition", command: "complete" },
    });
  });

  test("settles every terminal outcome kind", () => {
    const cases: Array<{
      command: TurnCommand;
      outcome: TerminalOutcome;
      effect?: "none" | "partial" | "uncertain";
    }> = [
      { command: "complete", outcome: { kind: "completed" } },
      { command: "fail", outcome: { kind: "failed", effect: "none" }, effect: "none" },
      { command: "cancel", outcome: { kind: "cancelled", effect: "none" }, effect: "none" },
      {
        command: "time-out",
        outcome: { kind: "timed-out", effect: "uncertain" },
        effect: "uncertain",
      },
      { command: "mark-uncertain", outcome: { kind: "uncertain", effect: "uncertain" } },
    ];

    for (const entry of cases) {
      const evaluating = happyPathTo("evaluating-completion");
      const result = applyTurnTransition({
        snapshot: evaluating,
        command: entry.command,
        configurationGeneration: generation,
        ...(entry.effect === undefined ? {} : { effect: entry.effect }),
      });
      expect(result.kind).toBe("transitioned");
      if (result.kind === "transitioned") {
        expect(result.snapshot.status).toBe("terminal");
        if (result.snapshot.status === "terminal") {
          expect(result.snapshot.outcome).toEqual(entry.outcome);
        }
      }
    }
  });

  test("cancellation during capability execution becomes uncertain", () => {
    const executing = happyPathTo("executing-capability");
    const result = applyTurnTransition({
      snapshot: executing,
      command: "cancel",
      configurationGeneration: generation,
      effect: "none",
    });
    expect(result).toMatchObject({
      kind: "transitioned",
      snapshot: {
        status: "terminal",
        outcome: { kind: "uncertain", effect: "uncertain" },
      },
    });
  });

  test("rejects complete before evaluating-completion and model events after terminal", () => {
    const orienting = apply(start(), "begin-orienting");
    expect(
      applyTurnTransition({
        snapshot: orienting,
        command: "complete",
        configurationGeneration: generation,
      }),
    ).toMatchObject({
      kind: "rejected",
      error: { code: "illegal-transition", phase: "orienting", command: "complete" },
    });

    const terminal = apply(happyPathTo("evaluating-completion"), "complete");
    expect(
      applyTurnTransition({
        snapshot: terminal,
        command: "begin-awaiting-model",
        configurationGeneration: generation,
      }),
    ).toMatchObject({
      kind: "rejected",
      error: { code: "already-terminal", command: "begin-awaiting-model" },
    });
  });

  test("recovery starts a new runtime generation without mutating history shape", () => {
    const terminal = apply(happyPathTo("evaluating-completion"), "fail", "partial");
    expect(terminal.status).toBe("terminal");

    const sameGeneration = applyTurnTransition({
      snapshot: terminal,
      command: "recover",
      configurationGeneration: generation,
      recoveryGeneration: generation,
    });
    expect(sameGeneration.kind).toBe("rejected");

    const recovered = applyTurnTransition({
      snapshot: terminal,
      command: "recover",
      configurationGeneration: recoveryGeneration,
      recoveryGeneration,
    });
    expect(recovered).toMatchObject({
      kind: "transitioned",
      snapshot: {
        status: "active",
        phase: "orienting",
        runtimeGeneration: recoveryGeneration,
        recordedEffect: "partial",
      },
      observation: { command: "recover", from: "evaluating-completion", to: "orienting" },
    });
  });

  test("lists recover as the only command on a terminal turn", () => {
    const terminal = apply(happyPathTo("evaluating-completion"), "complete");
    expect(legalTurnCommands(terminal)).toEqual(["recover"]);
  });

  test("switch exhaustiveness covers every command", () => {
    for (const command of TURN_COMMANDS) {
      switch (command) {
        case "begin-orienting":
        case "begin-assembling-context":
        case "begin-awaiting-model":
        case "begin-handling-model-event":
        case "begin-executing-capability":
        case "begin-evaluating-completion":
        case "cycle-to-model":
        case "complete":
        case "fail":
        case "cancel":
        case "time-out":
        case "mark-uncertain":
        case "recover":
          break;
        default:
          assertNever(command, "unhandled turn command");
      }
    }
  });
});
