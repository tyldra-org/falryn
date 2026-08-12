import { describe, expect, test } from "bun:test";

import {
  configurationGeneration,
  createManualClock,
  duration,
  type QueueLimits,
  sessionId,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import {
  createDeterministicProviderAdapter,
  deterministicEchoRequest,
  type NormalizedProviderEvent,
} from "../providers/index.ts";
import {
  createProviderStreamConsumer,
  DEFAULT_PROVIDER_STREAM_QUEUE_LIMITS,
} from "./provider-stream-consumer.ts";
import { createTurnCoordinator } from "./turn-coordinator.ts";

const generation = configurationGeneration.from(0);

function limits(overrides: Partial<QueueLimits> = {}): QueueLimits {
  return {
    ...DEFAULT_PROVIDER_STREAM_QUEUE_LIMITS,
    ...overrides,
  };
}

function startAtAssemblingContext() {
  const coordinator = createTurnCoordinator();
  const id = turnId.from("turn-stream-1");
  expect(
    coordinator.start({
      turnId: id,
      sessionId: sessionId.from("session-1"),
      workspaceId: workspaceId.from("workspace-1"),
      traceId: traceId.from("trace-1"),
      configurationGeneration: generation,
    }).ok,
  ).toBe(true);
  for (const command of ["begin-orienting", "begin-assembling-context"] as const) {
    expect(
      coordinator.apply({
        turnId: id,
        command,
        configurationGeneration: generation,
      }).ok,
    ).toBe(true);
  }
  return { coordinator, turnId: id };
}

async function collectEvents(
  events: AsyncIterable<NormalizedProviderEvent>,
): Promise<NormalizedProviderEvent[]> {
  const collected: NormalizedProviderEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("provider stream consumer", () => {
  test("consumes a finished text stream with ordering and completes the turn", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const clock = createManualClock();
    const consumer = createProviderStreamConsumer({ clock, coordinator });
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "text",
        textFragments: ["hel", "lo"],
        finishReason: "stop",
        usage: null,
      },
    });

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: adapter.stream(deterministicEchoRequest(), {
        signal: new AbortController().signal,
      }),
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") {
      return;
    }
    expect(outcome.snapshot.text).toBe("hello");
    expect(outcome.finishReason).toBe("stop");
    expect(outcome.toolProposals).toEqual([]);
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "completed" },
    });
    expect(outcome.queueReport.accepted).toBeGreaterThan(0);
    expect(outcome.queueReport.rejected).toBe(0);
  });

  test("leaves the turn at handling-model-event when tools are proposed", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
    });
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "tool",
        toolCallId: "call-1",
        name: "read_file",
        argumentFragments: ['{"path":', '"a.ts"}'],
      },
    });

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: adapter.stream(deterministicEchoRequest(), {
        signal: new AbortController().signal,
      }),
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") {
      return;
    }
    expect(outcome.toolProposals).toHaveLength(1);
    expect(outcome.toolProposals[0]?.name).toBe("read_file");
    expect(outcome.turn).toMatchObject({
      status: "active",
      phase: "handling-model-event",
    });
  });

  test("settles cancellation from an abortable mid-stream script", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
    });
    const controller = new AbortController();
    const request = deterministicEchoRequest();
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "abortable",
        prefixText: "partial-",
        hangUntilAbort: true,
      },
    });

    async function* gated(): AsyncIterable<NormalizedProviderEvent> {
      for await (const event of adapter.stream(request, { signal: controller.signal })) {
        yield event;
        if (event.kind === "text-delta") {
          // Abort only after assembled content exists so effect is partial.
          queueMicrotask(() => controller.abort());
        }
      }
    }

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: gated(),
      signal: controller.signal,
    });

    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind !== "cancelled") {
      return;
    }
    expect(outcome.effect).toBe("partial");
    expect(outcome.snapshot.text).toBe("partial-");
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "cancelled", effect: "partial" },
    });
  });

  test("settles timeout when the provider reports timeout", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
    });
    const controller = new AbortController();
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "abortable",
        hangUntilAbort: true,
        abortFailureKind: "timeout",
      },
    });

    const pending = consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: adapter.stream(deterministicEchoRequest(), { signal: controller.signal }),
      signal: controller.signal,
      abortAs: "timeout",
    });
    await Promise.resolve();
    controller.abort();
    const outcome = await pending;

    expect(outcome.kind).toBe("timed-out");
    if (outcome.kind !== "timed-out") {
      return;
    }
    expect(outcome.effect).toBe("none");
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "timed-out", effect: "none" },
    });
  });

  test("reports malformed when sequence integrity fails", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
    });

    async function* broken(): AsyncIterable<NormalizedProviderEvent> {
      const base = await collectEvents(
        createDeterministicProviderAdapter({
          script: { kind: "text", text: "x", usage: null },
        }).stream(deterministicEchoRequest(), { signal: new AbortController().signal }),
      );
      const first = base[0];
      if (first === undefined) {
        throw new Error("expected events");
      }
      yield first;
      yield {
        ...first,
        kind: "text-delta",
        text: "gap",
        sequence: 99,
      };
    }

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: broken(),
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("malformed");
    if (outcome.kind !== "malformed") {
      return;
    }
    expect(outcome.failure.kind).toBe("malformed-stream");
    expect(outcome.snapshot.diagnostics.some((d) => d.code === "sequence-gap")).toBe(true);
    expect(outcome.turn).toMatchObject({ status: "terminal", outcome: { kind: "failed" } });
  });

  test("reports partial when the stream omits a terminal event", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
    });
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "text",
        text: "orphan",
        usage: null,
        omitTerminal: true,
      },
    });

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: adapter.stream(deterministicEchoRequest(), {
        signal: new AbortController().signal,
      }),
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("partial");
    if (outcome.kind !== "partial") {
      return;
    }
    expect(outcome.reason).toBe("missing-terminal");
    expect(outcome.snapshot.text).toBe("orphan");
    expect(outcome.turn).toMatchObject({ status: "terminal", outcome: { kind: "failed" } });
  });

  test("rejects semantic overflow under coalesce backpressure without unbounded growth", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
      queueLimits: limits({
        maxItems: 8,
        // Smaller than the approximate usage event size (32).
        maxBytes: 8,
        maxItemAgeMs: duration(60_000),
        overflow: "reject",
      }),
    });

    async function* oversized(): AsyncIterable<NormalizedProviderEvent> {
      const requestId = deterministicEchoRequest().requestId;
      const attempt = (
        await collectEvents(
          createDeterministicProviderAdapter().stream(deterministicEchoRequest(), {
            signal: new AbortController().signal,
          }),
        )
      )[0]?.modelAttemptId;
      if (attempt === undefined) {
        throw new Error("expected attempt");
      }
      yield {
        kind: "request-started",
        requestId,
        modelAttemptId: attempt,
        sequence: 1,
      };
    }

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: oversized(),
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("backpressure-rejected");
    if (outcome.kind !== "backpressure-rejected") {
      return;
    }
    expect(outcome.limit).toBe("bytes");
    expect(outcome.maximum).toBe(8);
    expect(outcome.queueReport.rejected).toBeGreaterThanOrEqual(1);
    expect(outcome.queueReport.bytes).toBeLessThanOrEqual(8);
    expect(outcome.turn).toMatchObject({ status: "terminal", outcome: { kind: "failed" } });
  });

  test("coalesces display-only deltas instead of rejecting under pressure", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
      queueLimits: limits({
        // Room for request-started + one coalesced text slot; finished drains
        // display first then admits.
        maxItems: 2,
        maxBytes: 10_000,
        overflow: "coalesce",
      }),
    });

    async function* manyDeltas(): AsyncIterable<NormalizedProviderEvent> {
      const request = deterministicEchoRequest();
      const started = (
        await collectEvents(
          createDeterministicProviderAdapter().stream(request, {
            signal: new AbortController().signal,
          }),
        )
      )[0];
      if (started === undefined) {
        throw new Error("expected start");
      }
      let sequence = 1;
      yield {
        kind: "request-started",
        requestId: request.requestId,
        modelAttemptId: started.modelAttemptId,
        sequence: sequence++,
      };
      for (const text of ["a", "b", "c", "d", "e"]) {
        yield {
          kind: "text-delta",
          requestId: request.requestId,
          modelAttemptId: started.modelAttemptId,
          sequence: sequence++,
          text,
        };
      }
      yield {
        kind: "finished",
        requestId: request.requestId,
        modelAttemptId: started.modelAttemptId,
        sequence: sequence++,
        finishReason: "stop",
      };
    }

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: manyDeltas(),
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") {
      return;
    }
    expect(outcome.snapshot.text).toBe("abcde");
    expect(outcome.queueReport.coalesced).toBeGreaterThan(0);
    // A single soft reject may occur before display is drained to admit finished.
    expect(outcome.queueReport.rejected).toBeLessThanOrEqual(1);
    expect(outcome.turn).toMatchObject({
      status: "terminal",
      outcome: { kind: "completed" },
    });
  });

  test("reports failed for a scripted provider server failure", async () => {
    const { coordinator, turnId: id } = startAtAssemblingContext();
    const consumer = createProviderStreamConsumer({
      clock: createManualClock(),
      coordinator,
    });
    const adapter = createDeterministicProviderAdapter({
      script: {
        kind: "error",
        failureKind: "server-failure",
        message: "upstream unavailable",
        retryable: true,
      },
    });

    const outcome = await consumer.consume({
      turnId: id,
      configurationGeneration: generation,
      events: adapter.stream(deterministicEchoRequest(), {
        signal: new AbortController().signal,
      }),
      signal: new AbortController().signal,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") {
      return;
    }
    expect(outcome.failure.kind).toBe("server-failure");
    expect(outcome.turn).toMatchObject({ status: "terminal", outcome: { kind: "failed" } });
  });
});
