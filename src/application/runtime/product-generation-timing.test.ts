import { describe, expect, test } from "bun:test";
import { createManualClock, duration, instant, turnId } from "../../domain/foundation/index.ts";
import type { GenerationRate, RuntimeEvent } from "../../domain/sessions/index.ts";
import { parseWireEvent, toWireEvent } from "../../domain/sessions/wire.ts";
import { generationProduct, textThenTool, timedText } from "./product-generation.fixture.ts";

const TEN_TOKENS = "x".repeat(40);

function attemptCompletions(events: readonly RuntimeEvent[]) {
  return events.flatMap((event) => (event.kind === "model.attempt.completed" ? [event] : []));
}

/** Drives the manual clock for flows that wait on it (retry backoff, concurrency). */
async function pump<T>(clock: ReturnType<typeof createManualClock>, work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally(() => {
    settled = true;
  });
  for (let step = 0; step < 500 && !settled; step += 1) {
    await Bun.sleep(1);
    await clock.advance(duration(50));
  }
  return tracked;
}

describe("generation timing through the live product turn", () => {
  test("live and final rates agree within the window rules and the final fact persists and replays", async () => {
    const product = generationProduct();
    product.state.scripts.push(
      timedText({
        fragments: Array.from({ length: 10 }, () => TEN_TOKENS),
        firstAfterMs: 400,
        everyMs: 250,
        usage: { provenance: "provider-reported", outputTokens: 100 },
      }),
    );
    const live: { at: number; rate: GenerationRate }[] = [];
    product.executor.generation.subscribe(() => {
      const entry = product.executor.generation.current();
      if (entry?.phase === "live") live.push({ at: Number(product.clock.now()), rate: entry.rate });
    });

    const result = await product.executor.run({
      prompt: "Explain.",
      turnId: turnId.from("turn-1"),
    });

    expect(result.kind).toBe("completed");
    const [timing] = result.generation ?? [];
    if (timing === undefined) throw new Error("expected one generation fact");
    expect(result.generation).toHaveLength(1);
    // First delta 400 ms after start; ten deltas 250 ms apart; terminal 250 ms later.
    expect(timing).toMatchObject({
      completion: "complete",
      timeToFirstTokenMs: 400,
      generationMs: 2_500,
      tokens: { source: "provider-reported", output: 100, reasoning: null },
      rate: { kind: "measured", tokensPerSecond: 40, source: "provider-reported" },
    });
    // At most one live update per 250 ms, always labelled as an estimate.
    expect(live.length).toBeGreaterThan(3);
    for (const [index, update] of live.entries()) {
      if (index > 0) expect(update.at - (live[index - 1]?.at ?? 0)).toBeGreaterThanOrEqual(250);
      expect(update.rate.kind === "measured" ? update.rate.source : "estimate").toBe("estimate");
    }
    expect(live.at(-1)?.rate).toEqual({
      kind: "measured",
      tokensPerSecond: 40,
      source: "estimate",
    });
    expect(product.executor.generation.current()).toMatchObject({ phase: "final", timing });

    const [completed] = attemptCompletions(result.events);
    expect(completed?.payload.generation).toEqual({ version: 1 as const, requests: [timing] });
    const reparsed = parseWireEvent(
      JSON.parse(JSON.stringify(toWireEvent(completed as RuntimeEvent))),
    );
    expect(
      reparsed.ok && reparsed.event.kind === "model.attempt.completed"
        ? reparsed.event.payload.generation
        : null,
    ).toEqual({ version: 1 as const, requests: [timing] });

    const streams = product.state.streams;
    const replay = await product.runtime.journal.replayTurn(turnId.from("turn-1"));
    if (replay.kind !== "rebuilt") throw new Error(replay.kind);
    expect(replay.turns[0]?.attempts[0]?.generation).toEqual({
      version: 1 as const,
      requests: [timing],
    });
    expect(product.state.streams).toBe(streams);
  });

  test("without reported usage the rate is an estimate; without usage or text it is unknown", async () => {
    const product = generationProduct();
    product.state.scripts.push(
      timedText({
        fragments: Array.from({ length: 10 }, () => TEN_TOKENS),
        firstAfterMs: 100,
        everyMs: 250,
      }),
    );
    const estimated = await product.executor.run({ prompt: "Go.", turnId: turnId.from("t-est") });
    expect(estimated.generation?.[0]).toMatchObject({
      tokens: { source: "estimate", output: 100 },
      rate: { kind: "measured", tokensPerSecond: 40, source: "estimate" },
    });

    product.state.fallback = async function* () {
      yield { kind: "finished", finishReason: "stop" };
    };
    const silent = await product.executor.run({ prompt: "Go.", turnId: turnId.from("t-none") });
    expect(silent.generation?.length).toBeGreaterThan(0);
    for (const timing of silent.generation ?? []) {
      expect(timing.tokens).toEqual({ source: "unknown", output: null, reasoning: null });
      expect(timing.rate).toEqual({ kind: "unknown" });
      expect(timing.timeToFirstTokenMs).toBeNull();
    }
  });

  test("tool execution and confirmation between two streams count toward neither", async () => {
    const product = generationProduct({ toolMs: 5_000, confirmationMs: 7_000 });
    product.state.scripts.push(
      textThenTool({
        text: TEN_TOKENS,
        firstAfterMs: 150,
        proposalAfterMs: 300,
        name: "write_files",
        argumentsJson: JSON.stringify({
          targets: [{ kind: "create", path: "notes.txt", text: "hello\n" }],
        }),
      }),
      timedText({
        fragments: [TEN_TOKENS, TEN_TOKENS],
        firstAfterMs: 200,
        everyMs: 250,
        usage: { provenance: "provider-reported", outputTokens: 20 },
      }),
    );

    const result = await product.executor.run({
      prompt: "Write notes.",
      turnId: turnId.from("tool"),
    });

    expect(result.kind).toBe("completed");
    expect(product.state.confirmations).toBe(1);
    expect(product.state.toolRuns).toBe(1);
    expect(result.modelAttempts).toBe(1);
    const [first, second] = result.generation ?? [];
    expect(result.generation).toHaveLength(2);
    expect(first?.requestId).not.toBe(second?.requestId);
    expect(first).toMatchObject({ timeToFirstTokenMs: 150, generationMs: 300 });
    expect(second).toMatchObject({
      timeToFirstTokenMs: 200,
      generationMs: 500,
      rate: { kind: "measured", tokensPerSecond: 40, source: "provider-reported" },
    });
  });

  test("cancellation mid-stream records a partial fact", async () => {
    const product = generationProduct();
    const controller = new AbortController();
    product.state.scripts.push(async function* (_spine, clock) {
      for (let index = 0; index < 4; index += 1) {
        await clock.advance(duration(100));
        yield { kind: "text-delta", text: TEN_TOKENS };
      }
      controller.abort();
      await clock.advance(duration(100));
      yield { kind: "text-delta", text: TEN_TOKENS };
      yield { kind: "finished", finishReason: "stop" };
    });

    const result = await product.executor.run({
      prompt: "Go.",
      turnId: turnId.from("cancel"),
      signal: controller.signal,
    });

    const [timing] = result.generation ?? [];
    if (timing === undefined) throw new Error(`expected a partial fact (${result.code})`);
    expect(timing).toMatchObject({
      completion: "partial",
      timeToFirstTokenMs: 100,
      tokens: { source: "estimate" },
    });
    expect(attemptCompletions(result.events)[0]?.payload.generation?.requests).toEqual([timing]);
  });

  test("a retry after a rate limit records each attempt separately", async () => {
    const product = generationProduct();
    product.state.scripts.push(
      async function* () {
        yield {
          kind: "error",
          failure: {
            kind: "rate-limit",
            retryable: true,
            retryAfterMs: 0,
            message: "fixture quota refusal",
          },
        };
      },
      timedText({ fragments: [TEN_TOKENS, TEN_TOKENS], firstAfterMs: 100, everyMs: 250 }),
    );

    const result = await pump(
      product.clock,
      product.executor.run({ prompt: "Go.", turnId: turnId.from("retry") }),
    );

    expect(result.kind).toBe("completed");
    const completions = attemptCompletions(result.events);
    expect(completions).toHaveLength(2);
    const [refused, served] = completions.map((event) => event.payload.generation?.requests ?? []);
    expect(refused).toHaveLength(1);
    expect(served).toHaveLength(1);
    expect(refused?.[0]).toMatchObject({
      completion: "partial",
      modelAttemptId: String(completions[0]?.modelAttemptId),
      rate: { kind: "unknown" },
    });
    expect(served?.[0]).toMatchObject({
      completion: "complete",
      modelAttemptId: String(completions[1]?.modelAttemptId),
      tokens: { source: "estimate", output: 20 },
    });
    expect(result.generation).toEqual([...(refused ?? []), ...(served ?? [])]);
  });

  test("a parent and two concurrent children each keep their own rate and totals", async () => {
    const clock = createManualClock(instant(1_000));
    const products = [100, 200, 300].map((outputTokens, index) => {
      const product = generationProduct({ clock, name: `agent-${index}` });
      product.state.scripts.push(async function* (_spine, paced) {
        for (let tick = 1; tick <= 6; tick += 1) {
          await paced.waitUntil(instant(1_000 + tick * 300));
          yield { kind: "text-delta", text: TEN_TOKENS.repeat(index + 1) };
        }
        yield { kind: "usage", usage: { provenance: "provider-reported", outputTokens } };
        yield { kind: "finished", finishReason: "stop" };
      });
      return product;
    });

    const results = await pump(
      clock,
      Promise.all(
        products.map((product, index) =>
          product.executor.run({ prompt: "Go.", turnId: turnId.from(`agent-turn-${index}`) }),
        ),
      ),
    );

    for (const [index, result] of results.entries()) {
      expect(result.kind).toBe("completed");
      expect(result.generation).toHaveLength(1);
      expect(result.generation?.[0]).toMatchObject({
        tokens: { source: "provider-reported", output: [100, 200, 300][index] },
        rate: { kind: "measured", source: "provider-reported" },
      });
      const entry = products[index]?.executor.generation.current();
      expect(entry?.turnId).toBe(`agent-turn-${index}`);
    }
    // Each executor's result carries only its own streams.
    const attempts = results.map((result) =>
      (result.generation ?? []).map((timing) => timing.modelAttemptId),
    );
    expect(new Set(attempts.flat()).size).toBe(3);
  });
});
