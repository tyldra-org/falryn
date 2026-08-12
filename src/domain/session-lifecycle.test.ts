import { describe, expect, test } from "bun:test";

import {
  applySessionTransition,
  configurationGeneration,
  createSessionSnapshot,
  eventId,
  isSessionPhase,
  isSessionTerminalPhase,
  legalSessionCommands,
  SESSION_COMMANDS,
  SESSION_LIFECYCLE_SCHEMA_VERSION,
  SESSION_PHASES,
  sessionId,
  sessionPhaseLabel,
  workspaceId,
} from "./index.ts";
import { assertNever } from "./result.ts";

const generation = configurationGeneration.from(0);
const nextGeneration = configurationGeneration.from(1);

function snapshot() {
  return createSessionSnapshot({
    sessionId: sessionId.from("session-1"),
    workspaceId: workspaceId.from("workspace-1"),
    configurationGeneration: generation,
  });
}

function advance(command: (typeof SESSION_COMMANDS)[number], current = snapshot()) {
  const result = applySessionTransition({
    snapshot: current,
    command,
    configurationGeneration: generation,
  });
  expect(result.kind).toBe("transitioned");
  if (result.kind !== "transitioned") {
    throw new Error("expected transition");
  }
  return result.snapshot;
}

describe("session lifecycle", () => {
  test("declares every phase and labels them exhaustively", () => {
    expect([...SESSION_PHASES]).toEqual([
      "bootstrap",
      "ready",
      "active-turn",
      "recovering",
      "draining",
      "closed",
    ]);
    for (const phase of SESSION_PHASES) {
      expect(isSessionPhase(phase)).toBe(true);
      expect(sessionPhaseLabel(phase).length).toBeGreaterThan(0);
    }
    expect(isSessionPhase("running")).toBe(false);
    expect(isSessionTerminalPhase("closed")).toBe(true);
    expect(isSessionTerminalPhase("ready")).toBe(false);
  });

  test("walks bootstrap → ready → active-turn → ready → draining → closed", () => {
    let current = snapshot();
    expect(current.phase).toBe("bootstrap");
    current = advance("mark-ready", current);
    expect(current.phase).toBe("ready");
    current = advance("begin-turn", current);
    expect(current.phase).toBe("active-turn");
    current = advance("end-turn", current);
    expect(current.phase).toBe("ready");
    current = advance("begin-drain", current);
    expect(current.phase).toBe("draining");
    const closed = applySessionTransition({
      snapshot: current,
      command: "close",
      configurationGeneration: generation,
      outcome: { kind: "completed" },
    });
    expect(closed).toMatchObject({
      kind: "transitioned",
      snapshot: { phase: "closed", outcome: { kind: "completed" } },
    });
  });

  test("supports recovering without rewriting prior observations", () => {
    let current = advance("mark-ready");
    current = advance("begin-turn", current);
    const recovering = applySessionTransition({
      snapshot: current,
      command: "begin-recovery",
      configurationGeneration: nextGeneration,
      causationEventId: eventId.from("cause-1"),
    });
    expect(recovering.kind).toBe("transitioned");
    if (recovering.kind !== "transitioned") {
      return;
    }
    expect(recovering.snapshot.phase).toBe("recovering");
    expect(recovering.snapshot.phaseGeneration).toBe(nextGeneration);
    expect(recovering.observation.schemaVersion).toBe(SESSION_LIFECYCLE_SCHEMA_VERSION);
    expect(recovering.observation.causationEventId).toBe(eventId.from("cause-1"));
    expect(recovering.observation.from).toBe("active-turn");

    const ready = applySessionTransition({
      snapshot: recovering.snapshot,
      command: "finish-recovery",
      configurationGeneration: nextGeneration,
    });
    expect(ready).toMatchObject({
      kind: "transitioned",
      snapshot: { phase: "ready" },
    });
  });

  test("rejects illegal and post-close transitions", () => {
    const boot = snapshot();
    expect(
      applySessionTransition({
        snapshot: boot,
        command: "begin-turn",
        configurationGeneration: generation,
      }),
    ).toEqual({
      kind: "rejected",
      error: { code: "illegal-transition", phase: "bootstrap", command: "begin-turn" },
    });

    let current = advance("mark-ready");
    current = advance("begin-drain", current);
    current = advance("close", current);
    expect(
      applySessionTransition({
        snapshot: current,
        command: "mark-ready",
        configurationGeneration: generation,
      }),
    ).toEqual({
      kind: "rejected",
      error: { code: "already-closed", command: "mark-ready" },
    });
  });

  test("lists only legal commands per phase", () => {
    expect(legalSessionCommands("bootstrap")).toEqual(["mark-ready"]);
    expect(legalSessionCommands("closed")).toEqual([]);
    expect(legalSessionCommands("ready")).toEqual(["begin-turn", "begin-recovery", "begin-drain"]);
  });

  test("switch exhaustiveness covers every command", () => {
    for (const command of SESSION_COMMANDS) {
      switch (command) {
        case "mark-ready":
        case "begin-turn":
        case "end-turn":
        case "begin-recovery":
        case "finish-recovery":
        case "begin-drain":
        case "close":
          break;
        default:
          assertNever(command, "unhandled session command");
      }
    }
  });
});
