import { describe, expect, test } from "bun:test";
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
import { createInterruptionPolicy } from "./interruption.ts";
import { createMidTurnInputService } from "./mid-turn-input.ts";
import { createTurnCoordinator } from "./turn-coordinator.ts";

const generation = configurationGeneration.from(0);

function startedService() {
  const coordinator = createTurnCoordinator();
  const clock = createManualClock();
  const interruption = createInterruptionPolicy(clock);
  const service = createMidTurnInputService({
    sessionId: sessionId.from("session-1"),
    coordinator,
    interruption,
    nextFollowUpId: () => followUpId.from("fu-fixed"),
  });
  const started = coordinator.start({
    turnId: turnId.from("turn-1"),
    sessionId: sessionId.from("session-1"),
    workspaceId: workspaceId.from("workspace-1"),
    traceId: traceId.from("trace-1"),
    configurationGeneration: generation,
  });
  expect(started.ok).toBe(true);
  if (!started.ok) {
    throw new Error("start failed");
  }
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
  return { coordinator, service };
}

describe("mid-turn input service", () => {
  test("steers the active attempt and records semantic events", () => {
    const { service } = startedService();
    const result = service.classify({
      intent: "steer",
      request: { text: "prefer bun", attachmentIds: [], mentionIds: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.classification).toBe("steer");
    expect(service.events().map((event) => event.kind)).toContain("mid-turn.steer-attached");
  });

  test("queues a follow-up and refuses a second concurrent turn", () => {
    const { service } = startedService();
    const queued = service.classify({
      intent: "follow-up",
      request: { text: "add tests next", attachmentIds: [], mentionIds: [] },
    });
    expect(queued.ok).toBe(true);
    expect(service.assertCanStartTurn()?.code).toBe("second-turn-refused");
    expect(service.view().queue.entries).toHaveLength(1);
  });

  test("interrupt uses the cancellation ladder and keeps the queue", () => {
    const { coordinator, service } = startedService();
    expect(
      service.classify({
        intent: "follow-up",
        request: { text: "keep me", attachmentIds: [], mentionIds: [] },
        followUpId: followUpId.from("fu-keep"),
      }).ok,
    ).toBe(true);

    const interrupted = service.classify({
      intent: "interrupt",
      request: { text: "", attachmentIds: [], mentionIds: [] },
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) {
      return;
    }
    expect(interrupted.classification).toBe("interrupt");
    expect(interrupted.interrupt?.action).toBe("request-cancellation");
    expect(coordinator.get(turnId.from("turn-1"))?.status).toBe("terminal");
    expect(service.view().queue.entries).toHaveLength(1);

    service.syncFromTurn(coordinator.get(turnId.from("turn-1")));
    const started = service.startHeadFollowUp(turnId.from("turn-2"));
    expect(started.ok).toBe(true);
    if (!started.ok || started.started === null) {
      return;
    }
    expect(started.started.followUpId).toBe(followUpId.from("fu-keep"));
  });
});
