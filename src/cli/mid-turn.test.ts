/**
 * Headless mid-turn JSONL projection (#613).
 */

import { describe, expect, test } from "bun:test";
import { followUpId } from "../domain/index.ts";
import {
  classifyAndRenderJsonl,
  createHeadlessMidTurnService,
  resolveMidTurnIntent,
  runMidTurnClassify,
} from "./mid-turn.ts";

describe("resolveMidTurnIntent", () => {
  test("fails closed when intent is missing or unknown", () => {
    expect(resolveMidTurnIntent(null).ok).toBe(false);
    expect(resolveMidTurnIntent("").ok).toBe(false);
    expect(resolveMidTurnIntent("maybe").ok).toBe(false);
  });

  test("accepts the closed intent set", () => {
    expect(resolveMidTurnIntent("follow-up")).toEqual({ ok: true, intent: "follow-up" });
    expect(resolveMidTurnIntent("steer")).toEqual({ ok: true, intent: "steer" });
    expect(resolveMidTurnIntent("interrupt")).toEqual({ ok: true, intent: "interrupt" });
  });
});

describe("runMidTurnClassify", () => {
  test("queues a follow-up and reports queue order and depth", () => {
    const service = createHeadlessMidTurnService({
      nextFollowUpId: () => followUpId.from("fu-cli-1"),
    });
    const result = runMidTurnClassify({ intent: "follow-up", text: "add tests next" }, { service });
    expect(result.outcome.kind).toBe("completed");
    expect(result.payload?.classification).toBe("follow-up");
    expect(result.payload?.followUpId).toBe("fu-cli-1");
    expect(result.payload?.queueDepth).toBe(1);
    expect(result.payload?.queueOrder).toEqual(["fu-cli-1"]);
  });

  test("refuses without prompting when intent is absent", () => {
    const result = runMidTurnClassify({ intent: null, text: "hello" });
    expect(result.outcome.kind).toBe("failed");
    expect(result.payload).toBe(null);
    expect(result.errors[0]?.message).toContain("--intent");
  });
});

describe("classifyAndRenderJsonl", () => {
  test("emits mid-turn lifecycle lines then one terminal result", () => {
    const { result, lines } = classifyAndRenderJsonl({
      intent: "follow-up",
      text: "queue me",
      followUpId: "fu-jsonl-1",
    });
    expect(result.outcome.kind).toBe("completed");
    expect(lines.length).toBeGreaterThan(1);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const events = parsed.filter((row) => row.kind === "event");
    const terminal = parsed.at(-1);
    expect(terminal?.kind).toBe("result");
    expect(terminal?.terminal).toBe(true);
    expect(
      events.some((row) => (row.event as { kind?: string }).kind === "mid-turn.classified"),
    ).toBe(true);
    expect(
      events.some((row) => (row.event as { kind?: string }).kind === "mid-turn.follow-up-queued"),
    ).toBe(true);
    const queued = events.find(
      (row) => (row.event as { kind?: string }).kind === "mid-turn.follow-up-queued",
    );
    expect(queued).toBeDefined();
    if (queued === undefined) {
      return;
    }
    const queuedEvent = queued.event as {
      followUpId?: string;
      queueDepth?: number;
      queueOrder?: string[];
    };
    expect(queuedEvent.followUpId).toBe("fu-jsonl-1");
    expect(queuedEvent.queueDepth).toBe(1);
    expect(queuedEvent.queueOrder).toEqual(["fu-jsonl-1"]);
  });

  test("projects steer and interrupt classifications", () => {
    const steered = classifyAndRenderJsonl({ intent: "steer", text: "prefer bun" });
    expect(steered.result.payload?.classification).toBe("steer");
    expect(steered.lines.some((line) => line.includes("mid-turn.steer-attached"))).toBe(true);

    const interrupted = classifyAndRenderJsonl({ intent: "interrupt", text: "" });
    expect(interrupted.result.payload?.classification).toBe("interrupt");
    expect(interrupted.lines.some((line) => line.includes("mid-turn.interrupt-requested"))).toBe(
      true,
    );
  });

  test("names follow-up id and resulting queue order after promote", () => {
    let next = 0;
    const service = createHeadlessMidTurnService({
      nextFollowUpId: () => {
        next += 1;
        return followUpId.from(`fu-${next}`);
      },
    });
    expect(
      runMidTurnClassify({ intent: "follow-up", text: "first" }, { service }).payload?.followUpId,
    ).toBe("fu-1");
    expect(
      runMidTurnClassify({ intent: "follow-up", text: "second" }, { service }).payload?.followUpId,
    ).toBe("fu-2");
    const promoted = service.promote(followUpId.from("fu-2"));
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) {
      return;
    }
    const order = service.view().queue.entries.map((entry) => `${entry.followUpId}`);
    expect(order).toEqual(["fu-2", "fu-1"]);
    const { lines } = classifyAndRenderJsonl({ intent: "interrupt", text: "" }, { service });
    // Prior promote events remain on the service event log and project with order.
    expect(lines.some((line) => line.includes("mid-turn.follow-up-promoted"))).toBe(true);
    expect(lines.some((line) => line.includes('"fu-2"') && line.includes('"fu-1"'))).toBe(true);
  });
});
