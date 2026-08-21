/**
 * Session navigation overlays on a real terminal (#722).
 */

import { describe, expect, test } from "bun:test";
import { sessionRecord, sessionStarted, turnRecord } from "../../domain/fixtures.ts";
import {
  createInMemoryEventStore,
  err,
  ok,
  type RecordError,
  type RecordWrite,
  type SessionId,
  type SessionRecord,
  type SessionRepositoryPort,
  type TurnId,
  type TurnRecord,
  type TurnRepositoryPort,
  type WorkspaceId,
} from "../../domain/index.ts";
import { mount } from "../harness.tsx";
import { createSessionNavigationController } from "../session-nav/index.ts";
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
    workspace: known("falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the shell." }],
};

function memorySessions(records: SessionRecord[]): SessionRepositoryPort {
  return {
    insert(record: SessionRecord) {
      if (records.some((item) => item.sessionId === record.sessionId)) {
        const error: RecordError = {
          kind: "record",
          code: "already-exists",
          entity: "session",
          identity: record.sessionId,
        };
        return err(error);
      }
      records.push(record);
      const write: RecordWrite = { cancelledAfterCommit: false };
      return ok(write);
    },
    complete() {
      return ok({ cancelledAfterCommit: false });
    },
    get(id: SessionId) {
      return ok(records.find((record) => record.sessionId === id) ?? null);
    },
    listByParent(parentId: WorkspaceId, _limit: number) {
      return ok(records.filter((record) => record.workspaceId === parentId));
    },
  };
}

function memoryTurns(records: readonly TurnRecord[]): TurnRepositoryPort {
  return {
    insert() {
      return ok({ cancelledAfterCommit: false });
    },
    complete() {
      return ok({ cancelledAfterCommit: false });
    },
    get(id: TurnId) {
      return ok(records.find((record) => record.turnId === id) ?? null);
    },
    listByParent(parentId: SessionId, _limit: number) {
      return ok(records.filter((record) => record.sessionId === parentId));
    },
  };
}

function controllerForTests() {
  const record = sessionRecord();
  const events = createInMemoryEventStore();
  void events.append(sessionStarted(1));
  return createSessionNavigationController({
    sessions: memorySessions([record]),
    turns: memoryTurns([turnRecord({ sessionId: record.sessionId })]),
    events,
    workspaceId: record.workspaceId,
  });
}

async function runCommand(shell: Awaited<ReturnType<typeof mount>>, id: string): Promise<void> {
  await shell.frame();
  await shell.press("p", { ctrl: true });
  await shell.frame("Commands");
  await shell.type(id);
  shell.setup.mockInput.pressEnter();
}

describe("session navigation overlays", () => {
  test("opens replay with an effect-free notice", async () => {
    const controller = controllerForTests();
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        sessionNavigationController={controller}
      />,
    );
    await runCommand(shell, "session.replay");
    const frame = await shell.frame("Replay session");
    expect(frame).toContain("Replay session");
    expect(frame.toLowerCase()).toContain("effect-free");
  });

  test("keeps session navigation unavailable without a controller", async () => {
    using shell = await mount(<ShellApp theme={THEME} model={MODEL} onExit={() => {}} />);
    await shell.frame();
    await shell.press("p", { ctrl: true });
    await shell.frame("Commands");
    await shell.type("session.resume");
    const frame = await shell.frame("Resume session");
    expect(frame).toContain("Resume session");
    expect(frame.toLowerCase()).toContain("unavailable");
  });

  test("opens rewind with a turn draft field", async () => {
    const controller = controllerForTests();
    using shell = await mount(
      <ShellApp
        theme={THEME}
        model={MODEL}
        onExit={() => {}}
        sessionNavigationController={controller}
      />,
    );
    await runCommand(shell, "session.rewind");
    const frame = await shell.frame("Rewind session");
    expect(frame).toContain("Rewind session");
    expect(frame).toContain("Turn id");
  });
});
