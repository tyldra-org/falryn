import { describe, expect, test } from "bun:test";

import type { ProductLiveTurnExecutor } from "../../application/index.ts";
import { configurationGeneration, sessionId, turnId, workspaceId } from "../../domain/index.ts";
import { createProductSubmissionPort, snapshotOf, UNAVAILABLE_SUBMISSION } from "./index.ts";

const correlation = {
  workspaceId: workspaceId.from("workspace-submit-1"),
  sessionId: sessionId.from("session-submit-1"),
  configurationGeneration: configurationGeneration.from(0),
};

function executor(run: ProductLiveTurnExecutor["run"]): ProductLiveTurnExecutor {
  return { startSession: async () => null, run };
}

describe("product submission port", () => {
  test("accepts only after the live-turn executor completes", async () => {
    let turns = 0;
    let executions = 0;
    const port = createProductSubmissionPort({
      executor: executor(async () => {
        executions += 1;
        return {
          kind: "completed",
          code: "completed",
          message: "turn completed",
          response: "done",
          terminalOutcome: { kind: "completed" },
          events: [],
          contextPackItems: 0,
          modelAttempts: 1,
          toolResults: 0,
          disclosedTools: 0,
          contextStatus: "static",
          contextGeneration: null,
          recalledMemories: 0,
          memoryAdmission: "skipped",
        };
      }),
      sessionId: correlation.sessionId,
      configurationGeneration: correlation.configurationGeneration,
      nextTurnId: () => {
        turns += 1;
        return turnId.from(`turn-submit-${turns}`);
      },
    });

    const outcome = await port.submit(snapshotOf("ship the turn", 1));
    expect(outcome.kind).toBe("accepted");
    expect(executions).toBe(1);
  });

  test("derives default turn identities from the durable session", async () => {
    const observed: string[] = [];
    const live = executor(async (input) => {
      observed.push(String(input.turnId));
      return {
        kind: "completed",
        code: "completed",
        message: "turn completed",
        response: "done",
        terminalOutcome: { kind: "completed" },
        events: [],
        contextPackItems: 0,
        modelAttempts: 1,
        toolResults: 0,
        disclosedTools: 0,
        contextStatus: "static",
        contextGeneration: null,
        recalledMemories: 0,
        memoryAdmission: "skipped",
      };
    });
    const first = createProductSubmissionPort({
      executor: live,
      sessionId: sessionId.from("session-first"),
      configurationGeneration: correlation.configurationGeneration,
    });
    const second = createProductSubmissionPort({
      executor: live,
      sessionId: sessionId.from("session-second"),
      configurationGeneration: correlation.configurationGeneration,
    });

    await first.submit(snapshotOf("one", 1));
    await second.submit(snapshotOf("two", 1));

    expect(observed).toEqual(["turn-submit:session-first:1", "turn-submit:session-second:1"]);
  });

  test("fails closed for empty text and when not accepting", async () => {
    const port = createProductSubmissionPort({
      executor: executor(async () => {
        throw new Error("refused submissions must not execute");
      }),
      sessionId: correlation.sessionId,
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
