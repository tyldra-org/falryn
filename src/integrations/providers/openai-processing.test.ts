import { expect, test } from "bun:test";
import { modelId, providerId } from "../../domain/foundation/index.ts";
import { modelRequestId } from "../../providers/configuration/identity.ts";
import {
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  OPENAI_RESPONSES_TRANSPORT_DEFAULT,
} from "../../providers/configuration/transport-compatibility.ts";
import type { ModelRequest } from "../../providers/protocol/request.ts";
import type { NormalizedProviderEvent } from "../../providers/protocol/stream.ts";
import { admittedOpenAiRequest } from "./openai-processing-fixtures.ts";
import { createOpenAiProviderAdapter } from "./openai-provider-adapter.ts";
import { resolveProviderTransportCompatibilityPlan } from "./provider-transport-compatibility.ts";

const request: ModelRequest = {
  requestId: modelRequestId.from("processing-request"),
  providerId: providerId.from("openai"),
  modelId: modelId.from("gpt-5.6-sol"),
  messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
  tools: [
    {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ],
  output: {
    kind: "json-schema",
    name: "answer",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  reasoning: "balanced",
  reasoningControl: "medium",
  budgets: { maxOutputTokens: 100 },
  metadata: { role: "default" },
  promptCache: {
    schemaVersion: 1,
    key: `sha-256:${"a".repeat(64)}`,
    scope: "session",
    stablePrefixDigest: `sha-256:${"b".repeat(64)}`,
    stableMessageCount: 1,
    toolCatalogGeneration: 1,
    mode: "openai-routing-key",
    minimumInputTokens: 1024,
  },
};
const plans = [OPENAI_CHAT_TRANSPORT_DEFAULT, OPENAI_RESPONSES_TRANSPORT_DEFAULT] as const;

async function collect(
  adapter: ReturnType<typeof createOpenAiProviderAdapter>,
  input: ModelRequest,
  signal = new AbortController().signal,
) {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.stream(input, { signal })) events.push(event);
  return events;
}

for (const compatibility of plans) {
  test(`${compatibility.dialect} processing changes only the native tier, preserving strict output and cache affinity`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = createOpenAiProviderAdapter({
      profileId: "openai",
      baseUrl: "https://api.openai.com/v1",
      processingAccountGeneration: "account",
      supportedModels: ["gpt-5.6-sol"],
      compatibility,
      resolveApiKey: async () => "fixture",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const data =
          compatibility.dialect === "openai-responses"
            ? {
                type: "response.completed",
                sequence_number: 1,
                response: {
                  id: "response",
                  status: "completed",
                  output: [],
                  service_tier: "default",
                },
              }
            : { choices: [{ delta: {}, finish_reason: "stop" }], service_tier: "default" };
        return new Response(`data: ${JSON.stringify(data)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    for (const mode of ["fast", "standard"] as const) {
      const events = await collect(adapter, admittedOpenAiRequest(adapter, request, mode));
      expect(events.at(-1)?.kind).toBe("finished");
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.service_tier)).toEqual(["fast", "default"]);
    const withoutTier = bodies.map(({ service_tier: _tier, ...body }) => body);
    expect(withoutTier[0]).toEqual(withoutTier[1]);
    expect(bodies[0]?.prompt_cache_key).toBe(request.promptCache?.key);
    expect(JSON.stringify(bodies[0])).toContain('"strict":true');
    const plan = adapter.transportCompatibilityFor(request.modelId);
    expect(plan?.declaration.processingQualifications?.[0]?.operation).toBe(compatibility.dialect);
    expect(plan?.receipt.selectedLayer).toBe("destination-profile");
    const legacy = resolveProviderTransportCompatibilityPlan("openai", compatibility, {
      modelId: request.modelId,
    });
    if (!legacy.ok) throw new Error("Missing legacy wire plan");
    expect(plan?.compatibilityId).toBe(legacy.value.compatibilityId);
    expect(plan?.receipt).toEqual(legacy.value.receipt);
  });

  test(`${compatibility.dialect} does not retry quota failures and cancels its sole admitted request`, async () => {
    for (const failure of ["quota", "cancel"] as const) {
      const controller = new AbortController();
      let calls = 0;
      const adapter = createOpenAiProviderAdapter({
        profileId: "openai",
        baseUrl: "https://api.openai.com/v1",
        processingAccountGeneration: "account",
        supportedModels: ["gpt-5.6-sol"],
        compatibility,
        resolveApiKey: async () => "fixture",
        fetch: async (_url, init) => {
          calls++;
          expect(JSON.parse(String(init?.body)).service_tier).toBe("fast");
          if (failure === "quota")
            return new Response(
              JSON.stringify({ error: { message: "quota", type: "rate_limit_error" } }),
              { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } },
            );
          controller.abort();
          throw new DOMException("cancelled", "AbortError");
        },
      });
      const events = await collect(
        adapter,
        admittedOpenAiRequest(adapter, request, "fast"),
        controller.signal,
      );
      expect(events.at(-1)).toMatchObject({
        kind: "error",
        failure: { kind: failure === "quota" ? "rate-limit" : "cancellation" },
      });
      expect(calls).toBe(1);
      expect(events.some((event) => event.kind === "finished")).toBe(false);
    }
  });

  test(`${compatibility.dialect} refuses stale processing bindings before HTTP`, async () => {
    let calls = 0;
    const adapter = createOpenAiProviderAdapter({
      profileId: "openai",
      baseUrl: "https://api.openai.com/v1",
      processingAccountGeneration: "account",
      supportedModels: ["gpt-5.6-sol"],
      compatibility,
      resolveApiKey: async () => "fixture",
      fetch: async () => {
        calls++;
        throw new Error("Unexpected HTTP");
      },
    });
    const bound = admittedOpenAiRequest(adapter, request, "fast");
    if (!bound.processing) throw new Error("Missing binding");
    for (const change of [
      { accountGeneration: "changed" },
      { modelId: "gpt-5.6-luna" },
      { operation: "other-endpoint" },
      { nativeParameters: { serviceTier: "default", speed: null } },
    ] as const) {
      const events = await collect(adapter, {
        ...bound,
        processing: { ...bound.processing, ...change },
      });
      expect(events.at(-1)?.kind).toBe("error");
    }
    expect(calls).toBe(0);
  });
}

test("qualification never infers Fast from an unfamiliar exact model or custom endpoint", () => {
  for (const baseUrl of ["https://api.openai.com/v1", "https://gateway.example.test/v1"]) {
    const adapter = createOpenAiProviderAdapter({
      profileId: "openai",
      baseUrl,
      processingAccountGeneration: "account",
      supportedModels: ["gpt-5.6-sol", "gpt-5.6-sol-unverified", "gpt-5.5"],
      compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
      resolveApiKey: async () => "fixture",
    });
    for (const model of adapter.supportedModels) {
      const support =
        adapter.transportCompatibilityFor(model)?.declaration.processingQualifications?.[0]?.modes
          .fast.support;
      expect(support === "supported").toBe(
        baseUrl === "https://api.openai.com/v1" && model === "gpt-5.6-sol",
      );
    }
  }
});

test("Codex model qualification is restricted to its documented Responses operation", () => {
  for (const compatibility of plans) {
    const adapter = createOpenAiProviderAdapter({
      profileId: "openai",
      baseUrl: "https://api.openai.com/v1",
      processingAccountGeneration: "account",
      supportedModels: ["gpt-5.3-codex"],
      compatibility,
      resolveApiKey: async () => "fixture",
    });
    const qualification = adapter.transportCompatibilityFor(modelId.from("gpt-5.3-codex"))
      ?.declaration.processingQualifications?.[0];
    expect(qualification?.modes.fast.support).toBe(
      compatibility.dialect === "openai-responses" ? "supported" : "unknown",
    );
    expect(qualification?.modes.standard.support).toBe(
      compatibility.dialect === "openai-responses" ? "supported" : "unknown",
    );
  }
});
