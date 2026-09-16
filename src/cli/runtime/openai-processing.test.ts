import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { openAiProcessingJourney, processingResponse } from "./openai-processing-fixtures.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const register = (home: string) => {
  homes.push(home);
};

test("typed processing controls save through the real writer and restart into a single downgraded OpenAI request", async () => {
  const journey = await openAiProcessingJourney(
    { dialect: "responses", mode: "fast", tier: "default", throughControls: true },
    register,
  );
  expect(journey.controlResults[0]).toMatchObject({
    kind: "processing-inspection",
    selection: { preference: { mode: "standard" } },
  });
  expect(journey.controlResults[1]).toMatchObject({ kind: "written" });
  expect(journey.controlResults[2]).toMatchObject({
    kind: "processing-inspection",
    selection: { preference: { mode: "fast" } },
  });
  expect(journey.bodies).toHaveLength(1);
  expect(journey.bodies[0]).toMatchObject({
    model: "gpt-5.6-sol",
    service_tier: "fast",
    reasoning: { effort: "medium" },
  });
  expect(journey.receipts).toHaveLength(1);
  expect(journey.receipts[0]).toMatchObject({
    actualMode: "standard",
    binding: { preference: { mode: "fast" } },
  });
});

test.each(["chat", "responses"] as const)(
  "real OpenAI %s processing preserves the request and records actual tiers",
  async (dialect) => {
    for (const [mode, tier, actual] of [
      ["standard", "default", "standard"],
      ["fast", "fast", "fast"],
      ["fast", "priority", "fast"],
      ["fast", "default", "standard"],
      ["fast", undefined, "unknown"],
      ["fast", "secret-unrecognized-tier", "unknown"],
      ["provider-default", "fast", "fast"],
    ] as const) {
      const journey = await openAiProcessingJourney({ dialect, mode, tier }, register);
      expect(journey.result.outcome.kind, JSON.stringify(journey.result)).toBe("completed");
      expect(journey.bodies).toHaveLength(1);
      const body = journey.bodies[0];
      expect(body?.model).toBe("gpt-5.6-sol");
      expect(body?.stream).toBe(true);
      expect(body?.service_tier).toBe(
        mode === "fast"
          ? "fast"
          : mode === "standard"
            ? "default"
            : dialect === "responses"
              ? "auto"
              : undefined,
      );
      expect(dialect === "responses" ? body?.reasoning : body?.reasoning_effort).toEqual(
        dialect === "responses" ? { effort: "medium", summary: "auto" } : "medium",
      );
      expect(Array.isArray(body?.tools)).toBe(true);
      expect(journey.urls[0]).toEndWith(
        dialect === "responses" ? "/responses" : "/chat/completions",
      );
      const serialized = JSON.stringify(journey.events);
      expect(serialized).toContain('"kind":"model.processing.recorded"');
      expect(serialized).toContain(`"actualMode":"${actual}"`);
      expect(serialized).not.toContain("secret-unrecognized-tier");
      expect(serialized).not.toContain("fixture-only");
    }
  },
  30000,
);

test.each(["chat", "responses"] as const)(
  "custom %s Fast refuses before HTTP and ordinary inference still works",
  async (dialect) => {
    const fast = await openAiProcessingJourney({ dialect, mode: "fast", custom: true }, register);
    expect(fast.result.outcome.kind).toBe("failed");
    expect(fast.bodies).toHaveLength(0);
    const ordinary = await openAiProcessingJourney(
      { dialect, mode: "provider-default", custom: true, tier: "priority" },
      register,
    );
    expect(ordinary.result.outcome.kind, JSON.stringify(ordinary.result)).toBe("completed");
    expect(ordinary.bodies).toHaveLength(1);
    expect(ordinary.receipts[0]?.actualMode).toBe("unknown");
    expect(ordinary.receipts[0]?.observations[0]?.nativeTier).toBeNull();
  },
  10000,
);

test.each(["chat", "responses"] as const)(
  "%s reserves project-default premium rates and settles the actual tier",
  async (dialect) => {
    const standard = await openAiProcessingJourney(
      { dialect, mode: "standard", tier: "default" },
      register,
    );
    const premium = await openAiProcessingJourney(
      { dialect, mode: "provider-default", tier: "priority" },
      register,
    );
    const downgraded = await openAiProcessingJourney(
      { dialect, mode: "fast", tier: "default" },
      register,
    );
    const ordinaryPrice = standard.receipts[0];
    const premiumPrice = premium.receipts[0];
    expect(ordinaryPrice?.binding.maximumCostMicros).toBeGreaterThan(0);
    expect(premiumPrice?.binding.maximumCostMicros).toBeGreaterThan(
      ordinaryPrice?.binding.maximumCostMicros ?? 0,
    );
    expect(downgraded.receipts[0]?.binding.price).toEqual(premiumPrice?.binding.price);
    expect(downgraded.receipts[0]?.usageCostMaximumMicros).toBe(
      ordinaryPrice?.usageCostMaximumMicros,
    );
    expect(premiumPrice?.usageCostMaximumMicros).toBeGreaterThan(
      ordinaryPrice?.usageCostMaximumMicros ?? 0,
    );
    const cost = ordinaryPrice?.binding.maximumCostMicros;
    if (cost == null) throw new Error("Missing standard admission price");
    const refused = await openAiProcessingJourney(
      { dialect, mode: "provider-default", cost },
      register,
    );
    expect(refused.result.outcome.kind).toBe("failed");
    expect(refused.bodies).toHaveLength(0);
    expect(downgraded.bodies).toHaveLength(1);
  },
  15000,
);

test.each(["chat", "responses"] as const)(
  "real %s quota and cancellation keep the single-attempt budget",
  async (dialect) => {
    for (const failure of ["quota", "cancel"] as const) {
      const controller = new AbortController();
      const journey = await openAiProcessingJourney(
        {
          dialect,
          mode: "fast",
          signal: controller.signal,
          fetch: async () => {
            if (failure === "quota")
              return new Response(
                JSON.stringify({ error: { message: "quota", type: "rate_limit_error" } }),
                {
                  status: 429,
                  headers: { "content-type": "application/json", "retry-after": "0" },
                },
              );
            controller.abort();
            throw new DOMException("cancelled", "AbortError");
          },
        },
        register,
      );
      expect(journey.result.outcome.kind).not.toBe("completed");
      expect(journey.bodies).toHaveLength(1);
      expect(journey.result.payload?.providerRequests).toBe(1);
    }
  },
  15000,
);

test.each(["chat", "responses"] as const)(
  "%s resumes the same product history at Standard without repeating a completed tool",
  async (dialect) => {
    let call = 0;
    const journey = await openAiProcessingJourney(
      {
        dialect,
        mode: "fast",
        continueAt: "standard",
        fetch: async () => {
          call++;
          if (call > 1) return processingResponse(dialect, "default");
          const functionCall = {
            id: "file-call-item",
            type: "function_call",
            call_id: "file-call",
            name: "read_file",
            arguments: JSON.stringify(
              dialect === "responses"
                ? { input: { path: "sample.txt", outputMode: "raw", range: null, limits: null } }
                : { path: "sample.txt", outputMode: "raw" },
            ),
            status: "completed",
          };
          const events =
            dialect === "responses"
              ? [
                  {
                    type: "response.output_item.added",
                    sequence_number: 1,
                    output_index: 0,
                    item: { ...functionCall, arguments: "", status: "in_progress" },
                  },
                  {
                    type: "response.output_item.done",
                    sequence_number: 2,
                    output_index: 0,
                    item: functionCall,
                  },
                  {
                    type: "response.completed",
                    sequence_number: 3,
                    response: {
                      id: "file-response",
                      status: "completed",
                      output: [functionCall],
                      service_tier: "fast",
                    },
                  },
                ]
              : [
                  {
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "file-call",
                              type: "function",
                              function: { name: "read_file", arguments: functionCall.arguments },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                    service_tier: "fast",
                  },
                ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
      register,
    );
    expect(journey.result.outcome.kind, JSON.stringify(journey.result)).toBe("completed");
    expect(journey.followUp?.outcome.kind, JSON.stringify(journey.followUp)).toBe("completed");
    expect(journey.result.payload?.toolResults).toBe(1);
    expect(journey.followUp?.payload?.toolResults).toBe(0);
    expect(journey.bodies.map((body) => body.service_tier)).toEqual(["fast", "default"]);
    expect(JSON.stringify(journey.bodies[1])).toContain("processing continuity evidence");
    expect(JSON.stringify(journey.bodies[1])).toContain("file-call");
    // Saving a new policy deliberately changes the ordinary configuration cache generation.
    // The processing choice itself never adds a cache partition (adapter fixtures hold the generation fixed).
    expect(journey.receipts.map((receipt) => receipt.binding.cachePartition)).toEqual([null, null]);
    expect(journey.receipts[0]?.binding.configurationGeneration).not.toBe(
      journey.receipts[1]?.binding.configurationGeneration,
    );
    expect(journey.bodies.every((body) => typeof body.prompt_cache_key === "string")).toBe(true);
  },
  10000,
);
