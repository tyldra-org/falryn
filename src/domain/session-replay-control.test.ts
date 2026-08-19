/**
 * Replay controls: move a cursor without repeating effects.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sessionStarted, turnStarted } from "./fixtures.ts";
import { sequence } from "./identity.ts";
import {
  controlSessionReplay,
  SESSION_REPLAY_CONTROL_SOURCE,
  SESSION_REPLAY_CONTROL_VERSION,
} from "./session-replay-control.ts";

describe("controlSessionReplay", () => {
  test("plays without naming a tool or advancing the cursor", () => {
    const result = controlSessionReplay({
      events: [sessionStarted(1), turnStarted(2)],
      command: { kind: "play" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe("playing");
    expect(result.value.atSequence).toBeNull();
    expect(result.value.applied).toBe(0);
    expect(result.value.provenance).toEqual({
      version: SESSION_REPLAY_CONTROL_VERSION,
      source: SESSION_REPLAY_CONTROL_SOURCE,
      model: null,
    });
  });

  test("steps one recorded event and pauses", () => {
    const played = controlSessionReplay({
      events: [sessionStarted(1), turnStarted(2)],
      command: { kind: "play" },
    });
    expect(played.ok).toBe(true);
    if (!played.ok) {
      return;
    }
    const stepped = controlSessionReplay({
      events: [sessionStarted(1), turnStarted(2)],
      state: played.value,
      command: { kind: "step" },
    });
    expect(stepped.ok).toBe(true);
    if (stepped.ok) {
      expect(stepped.value.status).toBe("paused");
      expect(stepped.value.atSequence).toBe(sequence.from(1));
      expect(stepped.value.applied).toBe(1);
    }
  });

  test("seeks to a recorded sequence without applying later events", () => {
    const result = controlSessionReplay({
      events: [sessionStarted(1), turnStarted(2)],
      command: { kind: "seek", sequence: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("paused");
      expect(result.value.atSequence).toBe(sequence.from(1));
      expect(result.value.applied).toBe(1);
    }
  });

  test("refuses seeking a sequence the stream does not have", () => {
    const result = controlSessionReplay({
      events: [sessionStarted(1)],
      command: { kind: "seek", sequence: 9 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
    }
  });

  test("treats cancellation as cancelled, not as a completed replay", () => {
    const result = controlSessionReplay(
      { events: [sessionStarted(1)], command: { kind: "play" } },
      AbortSignal.abort(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const source = await readFile(new URL("./session-replay-control.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /CommandRunnerPort|ProviderPort|GitPort|FileSystemPort|Bun\.spawn|child_process|fetch\(|git add|git commit/,
    );
  });
});
