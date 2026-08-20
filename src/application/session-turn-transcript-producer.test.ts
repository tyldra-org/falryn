import { describe, expect, test } from "bun:test";
import { renderJsonl } from "../cli/render-jsonl.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  READ_ONLY_EFFECT,
} from "../cli/result.ts";
import {
  capabilityId,
  configurationGeneration,
  createInMemoryEventStore,
  createManualClock,
  instant,
  invocationId,
  modelAttemptId,
  sessionId,
  streamId,
  timestampFromEpochMilliseconds,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import { reduceTranscript } from "../presentation/index.ts";
import { composeProductAgentRuntime } from "./product-agent-runtime.ts";

const correlation = {
  workspaceId: workspaceId.from("workspace-producer-1"),
  sessionId: sessionId.from("session-producer-1"),
  traceId: traceId.from("trace-producer-1"),
  configurationGeneration: configurationGeneration.from(0),
};

describe("session turn transcript producer", () => {
  test("emits session/turn/model/tool events folded by transcript and JSONL alike", async () => {
    const composed = composeProductAgentRuntime({
      eventStore: createInMemoryEventStore(),
      clock: createManualClock(instant(2_000)),
      streamId: streamId.from("session:producer-1"),
      correlation,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) {
      return;
    }

    const producer = composed.value.attachments.turnProducer;
    const session = await producer.startSession({
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      configurationGeneration: correlation.configurationGeneration,
    });
    expect(session.ok).toBe(true);

    const tid = turnId.from("turn-producer-1");
    const started = await producer.startTurn({
      turnId: tid,
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      traceId: correlation.traceId,
      configurationGeneration: correlation.configurationGeneration,
    });
    expect(started.ok).toBe(true);

    const turnCorrelation = { ...correlation, turnId: tid };
    const attempt = await producer.recordModelAttempt({
      turnId: tid,
      modelAttemptId: modelAttemptId.from("attempt-producer-1"),
      correlation: turnCorrelation,
      outcome: { kind: "completed" },
    });
    expect(attempt.ok).toBe(true);

    const tool = await producer.recordToolInvocation({
      turnId: tid,
      invocationId: invocationId.from("inv-producer-1"),
      capabilityId: capabilityId.from("cap-producer-1"),
      correlation: turnCorrelation,
      outcome: { kind: "completed" },
    });
    expect(tool.ok).toBe(true);

    const completed = await producer.completeTurn({
      turnId: tid,
      sessionId: correlation.sessionId,
      workspaceId: correlation.workspaceId,
      traceId: correlation.traceId,
      configurationGeneration: correlation.configurationGeneration,
      outcome: { kind: "completed" },
    });
    expect(completed.ok).toBe(true);

    const events = producer.events();
    expect(events.map((event) => event.kind)).toEqual([
      "session.started",
      "turn.started",
      "model.attempt.started",
      "model.attempt.completed",
      "capability.invocation.started",
      "capability.invocation.completed",
      "turn.completed",
    ]);

    const transcript = reduceTranscript(events);
    expect(transcript.blocks.some((block) => block.kind === "notice")).toBe(true);
    expect(transcript.blocks.some((block) => block.kind === "model-outcome")).toBe(true);
    expect(transcript.blocks.some((block) => block.kind === "tool-result")).toBe(true);
    expect(transcript.blocks.some((block) => block.kind === "turn-outcome")).toBe(true);

    const replay = await composed.value.journal.replay();
    expect(replay.kind === "rebuilt" || replay.kind === "partial").toBe(true);

    const rendered = await renderJsonl({
      events,
      occurredAt: timestampFromEpochMilliseconds(2_000),
      result: {
        schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
        schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
        command: "doctor",
        outcome: { kind: "completed" },
        effect: READ_ONLY_EFFECT,
        payload: null,
        errors: [],
        warnings: [],
        omissions: [],
        truncation: [],
        artifacts: [],
        correlation: {
          workspaceId: null,
          sessionId: null,
          turnId: null,
          traceId: null,
          scopeId: null,
          invocationId: null,
          capabilityId: null,
          eventId: null,
        },
      },
    });
    const kinds = rendered.result
      .map((line) => {
        const parsed = JSON.parse(line) as { kind?: string; event?: { kind?: string } };
        return parsed.event?.kind ?? parsed.kind;
      })
      .filter((kind): kind is string => typeof kind === "string");
    expect(kinds).toContain("session.started");
    expect(kinds).toContain("turn.completed");
    expect(kinds).toContain("model.attempt.completed");
    expect(kinds).toContain("capability.invocation.completed");
  });
});
