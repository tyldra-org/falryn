import { describe, expect, test } from "bun:test";
import {
  type GenerationObservation,
  generationTimingRecordSchema,
  liveGenerationRate,
  MAX_GENERATION_REQUESTS,
  summarizeGeneration,
} from "./generation-timing.ts";

function observation(overrides: Partial<GenerationObservation> = {}): GenerationObservation {
  return {
    modelAttemptId: "attempt-1",
    requestId: "request-1",
    completion: "complete",
    requestStartedAt: 1_000,
    firstOutputAt: 1_300,
    terminalAt: 3_300,
    clockAnomaly: false,
    estimated: { text: 30, reasoning: 0 },
    usage: { provenance: "provider-reported", outputTokens: 100 },
    ...overrides,
  };
}

describe("final generation timing", () => {
  test("prefers provider-reported usage and measures first output to terminal", () => {
    expect(summarizeGeneration(observation())).toEqual({
      version: 1,
      modelAttemptId: "attempt-1",
      requestId: "request-1",
      completion: "complete",
      timeToFirstTokenMs: 300,
      generationMs: 2_000,
      tokens: { source: "provider-reported", output: 100, reasoning: null },
      rate: { kind: "measured", tokensPerSecond: 50, source: "provider-reported" },
    });
  });

  test("falls back to the delta-text estimate and reports reasoning separately", () => {
    const timing = summarizeGeneration(
      observation({ usage: null, estimated: { text: 30, reasoning: 10 } }),
    );
    expect(timing.tokens).toEqual({ source: "estimate", output: 40, reasoning: 10 });
    expect(timing.rate).toEqual({ kind: "measured", tokensPerSecond: 20, source: "estimate" });
  });

  test("keeps provider reasoning separate without deriving text from it", () => {
    const timing = summarizeGeneration(
      observation({
        usage: { provenance: "provider-reported", outputTokens: 100, reasoningTokens: 40 },
      }),
    );
    expect(timing.tokens).toEqual({ source: "provider-reported", output: 100, reasoning: 40 });
  });

  test("missing usage with no text is unknown, never zero", () => {
    const timing = summarizeGeneration(
      observation({ usage: null, estimated: { text: 0, reasoning: 0 }, firstOutputAt: null }),
    );
    expect(timing.tokens).toEqual({ source: "unknown", output: null, reasoning: null });
    expect(timing.rate).toEqual({ kind: "unknown" });
    expect(timing.timeToFirstTokenMs).toBeNull();
    expect(timing.generationMs).toBeNull();
  });

  test("estimated usage is not treated as provider-reported", () => {
    const timing = summarizeGeneration(
      observation({ usage: { provenance: "estimate", outputTokens: 999 } }),
    );
    expect(timing.tokens.source).toBe("estimate");
    expect(timing.tokens.output).toBe(30);
  });

  test("sample limits sit exactly at 250 ms and 8 tokens", () => {
    const at = (generationMs: number, outputTokens: number) =>
      summarizeGeneration(
        observation({
          firstOutputAt: 1_300,
          terminalAt: 1_300 + generationMs,
          usage: { provenance: "provider-reported", outputTokens },
        }),
      ).rate;
    expect(at(250, 8)).toEqual({
      kind: "measured",
      tokensPerSecond: 32,
      source: "provider-reported",
    });
    expect(at(249, 8)).toEqual({ kind: "insufficient-sample", source: "provider-reported" });
    expect(at(250, 7)).toEqual({ kind: "insufficient-sample", source: "provider-reported" });
  });

  test("a stream with usage but no output delta is an insufficient sample", () => {
    const timing = summarizeGeneration(observation({ firstOutputAt: null }));
    expect(timing.generationMs).toBeNull();
    expect(timing.rate).toEqual({ kind: "insufficient-sample", source: "provider-reported" });
  });

  test("a clock that went backwards makes timing unavailable but keeps counts", () => {
    const timing = summarizeGeneration(observation({ clockAnomaly: true }));
    expect(timing.rate).toEqual({ kind: "unavailable", reason: "clock-anomaly" });
    expect(timing.timeToFirstTokenMs).toBeNull();
    expect(timing.generationMs).toBeNull();
    expect(timing.tokens.output).toBe(100);
  });

  test("a cancelled stream keeps its partial completion label", () => {
    expect(summarizeGeneration(observation({ completion: "partial" })).completion).toBe("partial");
  });
});

describe("live generation rate", () => {
  const samples = [
    { at: 1_000, tokens: 10 },
    { at: 2_000, tokens: 10 },
    { at: 3_000, tokens: 10 },
  ];

  test("a young stream measures from its first output delta", () => {
    expect(liveGenerationRate(samples.slice(0, 2), 1_000, 2_000)).toEqual({
      kind: "measured",
      tokensPerSecond: 20,
      source: "estimate",
    });
  });

  test("the trailing window excludes samples at or before now minus two seconds", () => {
    // Window (1000, 3000]: the sample at exactly 1000 falls out.
    expect(liveGenerationRate(samples, 1_000, 3_000)).toEqual({
      kind: "measured",
      tokensPerSecond: 10,
      source: "estimate",
    });
    // One millisecond earlier the first sample is still inside.
    expect(liveGenerationRate(samples, 1_000, 2_999)).toEqual({
      kind: "measured",
      tokensPerSecond: 10,
      source: "estimate",
    });
  });

  test("less than 250 ms since first output is an insufficient sample", () => {
    expect(liveGenerationRate([{ at: 1_000, tokens: 50 }], 1_000, 1_249)).toEqual({
      kind: "insufficient-sample",
      source: "estimate",
    });
    expect(liveGenerationRate([], null, 5_000)).toEqual({
      kind: "insufficient-sample",
      source: "estimate",
    });
  });
});

describe("generation timing record", () => {
  const timing = summarizeGeneration(observation());

  test("round-trips through its schema", () => {
    const record = { version: 1 as const, requests: [timing] };
    expect(generationTimingRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  test("rejects duplicate requests, unknown versions and oversized records", () => {
    expect(
      generationTimingRecordSchema.safeParse({ version: 1, requests: [timing, timing] }).success,
    ).toBe(false);
    expect(generationTimingRecordSchema.safeParse({ version: 2, requests: [] }).success).toBe(
      false,
    );
    const many = Array.from({ length: MAX_GENERATION_REQUESTS + 1 }, (_, index) => ({
      ...timing,
      requestId: `request-${index}`,
    }));
    expect(generationTimingRecordSchema.safeParse({ version: 1, requests: many }).success).toBe(
      false,
    );
  });
});
