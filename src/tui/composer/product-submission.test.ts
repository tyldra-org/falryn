import { describe, expect, test } from "bun:test";

import { composeProductAgentRuntime } from "../../application/product-agent-runtime.ts";
import {
  configurationGeneration,
  createInMemoryEventStore,
  createManualClock,
  instant,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/index.ts";
import { createProductSubmissionPort, snapshotOf, UNAVAILABLE_SUBMISSION } from "./index.ts";

const correlation = {
  workspaceId: workspaceId.from("workspace-submit-1"),
  sessionId: sessionId.from("session-submit-1"),
  traceId: traceId.from("trace-submit-1"),
  configurationGeneration: configurationGeneration.from(0),
};

describe("product submission port", () => {
  test("accepts a non-empty snapshot by starting a session and turn", async () => {
    const composed = composeProductAgentRuntime({
      eventStore: createInMemoryEventStore(),
      clock: createManualClock(instant(3_000)),
      streamId: streamId.from("session:submit-1"),
      correlation,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }

    let turns = 0;
    let candidateReads = 0;
    const port = createProductSubmissionPort({
      producer: composed.value.attachments.turnProducer,
      workspaceId: correlation.workspaceId,
      sessionId: correlation.sessionId,
      traceId: correlation.traceId,
      configurationGeneration: correlation.configurationGeneration,
      nextTurnId: () => {
        turns += 1;
        return turnId.from(`turn-submit-${turns}`);
      },
      contextCandidates: () => {
        candidateReads += 1;
        return [];
      },
    });

    const outcome = await port.submit(snapshotOf("ship the turn", 1));
    expect(outcome.kind).toBe("accepted");
    expect(candidateReads).toBe(1);
    expect(composed.value.attachments.turnProducer.events().map((event) => event.kind)).toEqual([
      "session.started",
      "turn.started",
    ]);
  });

  test("fails closed for empty text and when not accepting", async () => {
    const composed = composeProductAgentRuntime({
      eventStore: createInMemoryEventStore(),
      clock: createManualClock(instant(3_000)),
      streamId: streamId.from("session:submit-2"),
      correlation,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }

    const port = createProductSubmissionPort({
      producer: composed.value.attachments.turnProducer,
      workspaceId: correlation.workspaceId,
      sessionId: correlation.sessionId,
      traceId: correlation.traceId,
      configurationGeneration: correlation.configurationGeneration,
      isAccepting: () => false,
    });

    const empty = await port.submit(snapshotOf("   ", 1));
    expect(empty.kind).toBe("unavailable");
    if (empty.kind === "unavailable") {
      expect(empty.reason).toContain("empty");
      expect(empty.owner).toBe("#707");
    }

    const refused = await port.submit(snapshotOf("hello", 2));
    expect(refused.kind).toBe("unavailable");
    if (refused.kind === "unavailable") {
      expect(refused.reason).toContain("not accepting");
    }
  });

  test("default unavailable stub names #707", () => {
    const outcome = UNAVAILABLE_SUBMISSION.submit(snapshotOf("hello", 1));
    expect(outcome).toMatchObject({
      kind: "unavailable",
      owner: "#707",
    });
  });
});
