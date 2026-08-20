/**
 * Live composer while a turn is in flight (#612).
 *
 * Mounts the shell with an attached mid-turn service so submit-while-active and
 * interrupt can be observed on a real OpenTUI frame.
 */

import { describe, expect, test } from "bun:test";
import {
  createInterruptionPolicy,
  createMidTurnInputService,
  createTurnCoordinator,
} from "../../application/index.ts";
import {
  configurationGeneration,
  createManualClock,
  followUpId,
  modelAttemptId,
  sessionId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/index.ts";
import { mount, type Rendered } from "../harness.tsx";
import type { ThemeRequest } from "../theme/index.ts";
import { known, type ShellModel, unavailable } from "../view-model.ts";
import { ShellApp } from "./shell-app.tsx";

const THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the shell." }],
};

const generation = configurationGeneration.from(0);

function activeMidTurn() {
  const coordinator = createTurnCoordinator();
  const service = createMidTurnInputService({
    sessionId: sessionId.from("session-1"),
    coordinator,
    interruption: createInterruptionPolicy(createManualClock()),
    nextFollowUpId: () => followUpId.from("fu-live"),
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

type Session = Rendered & {
  focusComposer(): Promise<string>;
  midTurn: ReturnType<typeof activeMidTurn>;
};

async function openWithMidTurn(): Promise<Session> {
  const midTurn = activeMidTurn();
  const shell = await mount(
    <ShellApp theme={THEME} model={MODEL} onExit={() => {}} midTurn={midTurn} />,
    { shape: { columns: 100, rows: 24 } },
  );
  await shell.frame();
  return Object.assign(shell, {
    midTurn,
    async focusComposer() {
      await shell.press("\t");
      return await shell.press("\t");
    },
  });
}

describe("live composer during an active turn", () => {
  test("stays editable and queues submit as a follow-up by default", async () => {
    using shell = await openWithMidTurn();
    await shell.focusComposer();
    await shell.type("still typing while active");
    expect(await shell.frame()).toContain("still typing while active");

    await shell.press("\r");
    expect(await shell.frame("Queued follow-up")).toContain("Queued follow-up");
    expect(shell.midTurn.view().queue.entries).toHaveLength(1);
    expect(shell.midTurn.view().queue.entries[0]?.request.text).toBe("still typing while active");
    expect(await shell.frame()).not.toContain("still typing while active");
  });

  test("interrupt via escape keeps the draft", async () => {
    using shell = await openWithMidTurn();
    await shell.focusComposer();
    await shell.type("keep this draft");
    expect(await shell.frame()).toContain("keep this draft");

    await shell.press("\u001b");
    const frame = await shell.frame("Draft kept");
    expect(frame).toContain("Cancelling");
    expect(frame).toContain("Draft kept");
    expect(frame).toContain("keep this draft");
  });
});
