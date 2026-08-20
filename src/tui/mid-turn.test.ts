import { describe, expect, test } from "bun:test";
import {
  createInterruptionPolicy,
  createMidTurnInputService,
  createTurnCoordinator,
} from "../application/index.ts";
import {
  configurationGeneration,
  createManualClock,
  followUpId,
  modelAttemptId,
  sessionId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { noticeForClassification, requestFromComposer, submitWhileActive } from "./mid-turn.ts";

const generation = configurationGeneration.from(0);

function activeService() {
  const coordinator = createTurnCoordinator();
  const service = createMidTurnInputService({
    sessionId: sessionId.from("session-1"),
    coordinator,
    interruption: createInterruptionPolicy(createManualClock()),
    nextFollowUpId: () => followUpId.from("fu-1"),
  });
  expect(
    coordinator.start({
      turnId: turnId.from("turn-1"),
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      traceId: traceId.from("trace-1"),
      configurationGeneration: generation,
    }).ok,
  ).toBe(true);
  for (const command of [
    "begin-orienting",
    "begin-assembling-context",
    "begin-awaiting-model",
  ] as const) {
    expect(
      coordinator.apply({
        turnId: turnId.from("turn-1"),
        command,
        configurationGeneration: generation,
      }).ok,
    ).toBe(true);
  }
  service.syncFromTurn(coordinator.get(turnId.from("turn-1")));
  service.setActiveAttempt(modelAttemptId.from("attempt-1"));
  return service;
}

describe("submitWhileActive", () => {
  test("defaults follow-up clear the draft and name the queue depth", () => {
    const service = activeService();
    const result = submitWhileActive(service, "follow-up", requestFromComposer("next please", []));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.classification).toBe("follow-up");
    expect(result.notice).toBe("Queued follow-up (1 waiting).");
    expect(result.clearDraft).toBe(true);
  });

  test("steer clears the draft", () => {
    const service = activeService();
    const result = submitWhileActive(service, "steer", requestFromComposer("use bun", []));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.clearDraft).toBe(true);
    expect(result.notice).toBe("Steered the in-flight attempt.");
  });

  test("interrupt keeps the draft", () => {
    const service = activeService();
    const result = submitWhileActive(service, "interrupt", requestFromComposer("still here", []));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.clearDraft).toBe(false);
    expect(result.notice).toBe("Cancelling the in-flight turn. Draft kept.");
    expect(noticeForClassification("interrupt", 0)).toContain("Draft kept");
  });
});
