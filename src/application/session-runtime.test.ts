import { describe, expect, test } from "bun:test";

import { configurationGeneration, sessionId, workspaceId } from "../domain/index.ts";
import { createSessionRuntime } from "./session-runtime.ts";

const generation = configurationGeneration.from(0);

describe("session runtime", () => {
  test("creates, advances, and closes a session through the public boundary", () => {
    const runtime = createSessionRuntime();
    const created = runtime.create({
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      configurationGeneration: generation,
    });
    expect(created.ok).toBe(true);

    expect(
      runtime.apply({
        sessionId: sessionId.from("session-1"),
        command: "mark-ready",
        configurationGeneration: generation,
      }).ok,
    ).toBe(true);
    expect(
      runtime.apply({
        sessionId: sessionId.from("session-1"),
        command: "begin-turn",
        configurationGeneration: generation,
      }).ok,
    ).toBe(true);
    expect(
      runtime.apply({
        sessionId: sessionId.from("session-1"),
        command: "end-turn",
        configurationGeneration: generation,
      }).ok,
    ).toBe(true);
    expect(
      runtime.apply({
        sessionId: sessionId.from("session-1"),
        command: "begin-drain",
        configurationGeneration: generation,
      }).ok,
    ).toBe(true);
    const closed = runtime.apply({
      sessionId: sessionId.from("session-1"),
      command: "close",
      configurationGeneration: generation,
      outcome: { kind: "completed" },
    });
    expect(closed.ok).toBe(true);
    expect(runtime.get(sessionId.from("session-1"))?.phase).toBe("closed");
    expect(runtime.observations(sessionId.from("session-1")).map((o) => o.to)).toEqual([
      "ready",
      "active-turn",
      "ready",
      "draining",
      "closed",
    ]);
  });

  test("rejects duplicate create and unknown session commands", () => {
    const runtime = createSessionRuntime();
    const input = {
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      configurationGeneration: generation,
    };
    expect(runtime.create(input).ok).toBe(true);
    expect(runtime.create(input)).toEqual({
      ok: false,
      error: { code: "session-already-exists", sessionId: sessionId.from("session-1") },
    });
    expect(
      runtime.apply({
        sessionId: sessionId.from("missing"),
        command: "mark-ready",
        configurationGeneration: generation,
      }),
    ).toEqual({
      ok: false,
      error: { code: "session-not-found", sessionId: sessionId.from("missing") },
    });
  });
});
