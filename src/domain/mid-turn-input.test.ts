import { describe, expect, test } from "bun:test";
import { followUpId, modelAttemptId, sessionId, turnId } from "./identity.ts";
import { MAX_FOLLOW_UP_QUEUE_ENTRIES } from "./limits.ts";
import {
  applyFollowUpAsSteer,
  classifyMidTurnInput,
  dropFollowUp,
  emptyFollowUpQueue,
  enqueueFollowUp,
  type MidTurnRequestSnapshot,
  type MidTurnSessionView,
  promoteFollowUp,
  refuseSecondInFlightTurn,
  takeHeadFollowUpForNextTurn,
} from "./mid-turn-input.ts";

const SESSION = sessionId.from("session-1");
const TURN = turnId.from("turn-1");
const ATTEMPT = modelAttemptId.from("attempt-1");

function request(text: string): MidTurnRequestSnapshot {
  return { text, attachmentIds: [], mentionIds: [] };
}

function activeSession(
  queueEntries: MidTurnSessionView["queue"]["entries"] = [],
): MidTurnSessionView {
  return {
    sessionId: SESSION,
    active: { turnId: TURN, attemptId: ATTEMPT },
    queue: { sessionId: SESSION, entries: queueEntries },
  };
}

describe("classifyMidTurnInput", () => {
  test("classifies steer against the in-flight attempt", () => {
    const result = classifyMidTurnInput({
      session: activeSession(),
      intent: "steer",
      request: request("use bun"),
      followUpId: followUpId.from("fu-1"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.classification).toBe("steer");
    expect(result.value.steer).toEqual(request("use bun"));
    expect(result.value.events.map((event) => event.kind)).toEqual([
      "mid-turn.classified",
      "mid-turn.steer-attached",
    ]);
  });

  test("queues a follow-up without starting a second turn", () => {
    const result = classifyMidTurnInput({
      session: activeSession(),
      intent: "follow-up",
      request: request("then add tests"),
      followUpId: followUpId.from("fu-2"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.classification).toBe("follow-up");
    expect(result.value.followUpId).toBe(followUpId.from("fu-2"));
    expect(result.value.session.active?.turnId).toBe(TURN);
    expect(result.value.session.queue.entries).toHaveLength(1);
  });

  test("classifies interrupt and leaves the queue intact", () => {
    const queued = enqueueFollowUp({
      queue: emptyFollowUpQueue(SESSION),
      followUpId: followUpId.from("fu-keep"),
      request: request("later"),
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) {
      return;
    }
    const result = classifyMidTurnInput({
      session: activeSession(queued.value.entries),
      intent: "interrupt",
      request: request(""),
      followUpId: followUpId.from("fu-unused"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.classification).toBe("interrupt");
    expect(result.value.session.queue.entries).toHaveLength(1);
  });

  test("refuses a missing intent instead of guessing", () => {
    const result = classifyMidTurnInput({
      session: activeSession(),
      intent: null,
      request: request("maybe"),
      followUpId: followUpId.from("fu-3"),
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "ambiguous-intent",
        reason: "mid-turn submit needs an explicit steer, follow-up, or interrupt intent",
      },
    });
  });

  test("refuses steer or follow-up when idle", () => {
    const idle: MidTurnSessionView = {
      sessionId: SESSION,
      active: null,
      queue: emptyFollowUpQueue(SESSION),
    };
    expect(
      classifyMidTurnInput({
        session: idle,
        intent: "steer",
        request: request("x"),
        followUpId: followUpId.from("fu-4"),
      }).ok,
    ).toBe(false);
  });
});

describe("follow-up queue", () => {
  test("refuses a second in-flight turn", () => {
    expect(refuseSecondInFlightTurn(activeSession())).toMatchObject({
      code: "second-turn-refused",
    });
  });

  test("refuses queue overflow without mutating entries", () => {
    let queue = emptyFollowUpQueue(SESSION);
    for (let i = 0; i < MAX_FOLLOW_UP_QUEUE_ENTRIES; i += 1) {
      const next = enqueueFollowUp({
        queue,
        followUpId: followUpId.from(`fu-${i}`),
        request: request(`item ${i}`),
      });
      expect(next.ok).toBe(true);
      if (!next.ok) {
        return;
      }
      queue = next.value;
    }
    const overflow = enqueueFollowUp({
      queue,
      followUpId: followUpId.from("fu-overflow"),
      request: request("nope"),
    });
    expect(overflow.ok).toBe(false);
    expect(queue.entries).toHaveLength(MAX_FOLLOW_UP_QUEUE_ENTRIES);
  });

  test("promotes, drops, applies as steer, and starts the head after idle", () => {
    let queue = emptyFollowUpQueue(SESSION);
    for (const id of ["fu-a", "fu-b", "fu-c"]) {
      const next = enqueueFollowUp({
        queue,
        followUpId: followUpId.from(id),
        request: request(id),
      });
      expect(next.ok).toBe(true);
      if (!next.ok) {
        return;
      }
      queue = next.value;
    }

    const promoted = promoteFollowUp(queue, followUpId.from("fu-c"));
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) {
      return;
    }
    expect(promoted.value.entries.map((entry) => entry.followUpId)).toEqual([
      followUpId.from("fu-c"),
      followUpId.from("fu-a"),
      followUpId.from("fu-b"),
    ]);

    const session: MidTurnSessionView = {
      sessionId: SESSION,
      active: { turnId: TURN, attemptId: ATTEMPT },
      queue: promoted.value,
    };
    const steered = applyFollowUpAsSteer(session, followUpId.from("fu-a"));
    expect(steered.ok).toBe(true);
    if (!steered.ok) {
      return;
    }
    expect(steered.value.steer.text).toBe("fu-a");
    expect(steered.value.session.queue.entries.map((entry) => entry.followUpId)).toEqual([
      followUpId.from("fu-c"),
      followUpId.from("fu-b"),
    ]);

    const dropped = dropFollowUp(steered.value.session.queue, followUpId.from("fu-b"));
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) {
      return;
    }

    const idle: MidTurnSessionView = {
      sessionId: SESSION,
      active: null,
      queue: dropped.value,
    };
    const started = takeHeadFollowUpForNextTurn(idle, turnId.from("turn-2"));
    expect(started.ok).toBe(true);
    if (!started.ok || started.value === null) {
      return;
    }
    expect(started.value.followUpId).toBe(followUpId.from("fu-c"));
    expect(started.value.session.active?.turnId).toBe(turnId.from("turn-2"));
    expect(started.value.session.queue.entries).toHaveLength(0);
  });
});
