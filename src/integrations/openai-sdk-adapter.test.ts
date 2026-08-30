/**
 * OpenAI SDK adapter tests.
 *
 * Uses the SDK's injectable fetch, with no live network. Opt-in live tests must never be
 * required by `bun run check`.
 */

import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/index.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import { createOpenAiSdkAdapter } from "./openai-sdk-adapter.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: modelRequestId.from("req-openai-1"),
    providerId: providerId.from("openai"),
    modelId: modelId.from("gpt-4o-mini"),
    messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
    tools: [],
    output: { kind: "text" },
    budgets: {},
    metadata: { role: "default" },
    ...overrides,
  };
}

async function collect(
  adapter: ReturnType<typeof createOpenAiSdkAdapter>,
  init?: AbortSignal,
  input: ModelRequest = request(),
): Promise<readonly NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  const signal = init ?? new AbortController().signal;
  for await (const event of adapter.stream(input, { signal })) {
    events.push(event);
  }
  return events;
}

function sseResponse(chunks: readonly string[], status = 200): Response {
  const body = chunks.join("");
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createOpenAiSdkAdapter", () => {
  test("defaults to the current OpenAI family in routing order", () => {
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.openai.com/v1",
      resolveApiKey: async () => "sk-test",
    });
    expect(adapter.supportedModels.map(String)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6",
    ]);
  });

  test("streams text deltas and finishes", async () => {
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ]),
    });
    const events = await collect(adapter);
    expect(events[0]?.kind).toBe("request-started");
    expect(events.some((event) => event.kind === "text-delta")).toBe(true);
    expect(events.at(-1)?.kind).toBe("finished");
  });

  test("requests and retains the trailing provider usage chunk", async () => {
    let body: Record<string, unknown> | null = null;
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async (_input, init) => {
        if (init === undefined) {
          throw new Error("expected OpenAI SDK request initialization");
        }
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":4},"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
          "data: [DONE]\n\n",
        ]);
      },
    });

    const events = await collect(adapter);
    expect(body).toMatchObject({ stream_options: { include_usage: true } });
    expect(events.find((event) => event.kind === "usage")).toMatchObject({
      kind: "usage",
      usage: {
        provenance: "provider-reported",
        inputTokens: 11,
        outputTokens: 3,
        totalTokens: 14,
        cachedInputTokens: 4,
        reasoningTokens: 1,
      },
    });
    expect(events.at(-1)).toMatchObject({ kind: "finished", finishReason: "stop" });
  });

  test("sends the secret-safe prompt cache key", async () => {
    let body: Record<string, unknown> | null = null;
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
      },
    });
    await collect(
      adapter,
      undefined,
      request({
        promptCache: {
          schemaVersion: 1,
          key: `sha-256:${"d".repeat(64)}`,
          scope: "session",
          stablePrefixDigest: `sha-256:${"e".repeat(64)}`,
          stableMessageCount: 1,
          toolCatalogGeneration: 1,
        },
      }),
    );
    expect(body).toMatchObject({ prompt_cache_key: `sha-256:${"d".repeat(64)}` });
    expect(JSON.stringify(body)).not.toContain("sk-test");
  });

  test("sends routed reasoning and response-density controls and rejects unresolved images", async () => {
    let body: Record<string, unknown> | null = null;
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
      },
    });
    await collect(
      adapter,
      undefined,
      request({
        reasoning: "balanced",
        reasoningControl: "medium",
        responseDensityControl: "low",
      }),
    );
    expect(body).toMatchObject({ reasoning_effort: "medium", verbosity: "low" });

    await collect(adapter, undefined, request({ reasoning: "max", reasoningControl: "max" }));
    expect(body).toMatchObject({ reasoning_effort: "max" });

    const visual = await collect(
      adapter,
      undefined,
      request({
        messages: [
          {
            role: "user",
            parts: [{ kind: "image", handle: "artifact:image", mediaType: "image/png" }],
          },
        ],
      }),
    );
    expect(visual.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "unsupported-capability", retryable: false },
    });
  });

  test("uses GPT-5 token budgets and translates the structured-output contract", async () => {
    let body: Record<string, unknown> | null = null;
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.openai.com/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async (_input, init) => {
        if (init === undefined) {
          throw new Error("expected OpenAI SDK request initialization");
        }
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
      },
    });
    const structured = request({
      modelId: modelId.from("gpt-5.6-sol"),
      output: {
        kind: "json-schema",
        name: "falryn_result",
        schema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
          additionalProperties: false,
        },
      },
      budgets: { maxOutputTokens: 4_096 },
    });

    for await (const _event of adapter.stream(structured, {
      signal: new AbortController().signal,
    })) {
      // Consume the deterministic response so the request body is observable.
    }

    expect(body).toMatchObject({
      model: "gpt-5.6-sol",
      max_completion_tokens: 4_096,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "falryn_result",
          strict: true,
          schema: {
            type: "object",
            required: ["result"],
            additionalProperties: false,
          },
        },
      },
    });
    expect(body).not.toHaveProperty("max_tokens");
  });

  test("classifies 429 as rate-limit", async () => {
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async () => new Response("rate", { status: 429 }),
    });
    const events = await collect(adapter);
    const error = events.find((event) => event.kind === "error");
    expect(error?.kind === "error" && error.failure.kind).toBe("rate-limit");
    expect(error?.kind === "error" && error.failure.retryable).toBe(true);
  });

  test("leaves retries to Falryn instead of retrying inside the SDK", async () => {
    let requests = 0;
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async () => {
        requests += 1;
        return new Response("failure", { status: 500 });
      },
    });

    const events = await collect(adapter);
    const error = events.find((event) => event.kind === "error");
    expect(requests).toBe(1);
    expect(error?.kind === "error" && error.failure.kind).toBe("server-failure");
    expect(error?.kind === "error" && error.failure.retryable).toBe(true);
  });

  test("classifies 401 as authentication", async () => {
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async () => new Response("nope", { status: 401 }),
    });
    const events = await collect(adapter);
    const error = events.find((event) => event.kind === "error");
    expect(error?.kind === "error" && error.failure.kind).toBe("authentication");
  });

  test("fails closed when the API key is missing", async () => {
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => null,
      fetch: async () => {
        throw new Error("fetch must not run");
      },
    });
    const events = await collect(adapter);
    const error = events.find((event) => event.kind === "error");
    expect(error?.kind === "error" && error.failure.kind).toBe("authentication");
  });

  test("classifies malformed JSON in the stream", async () => {
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async () => sseResponse(["data: {not-json}\n\n"]),
    });
    const events = await collect(adapter);
    const error = events.find((event) => event.kind === "error");
    expect(error?.kind === "error" && error.failure.kind).toBe("malformed-stream");
  });

  test("assembles fragmented tool calls into a proposal", async () => {
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"p\\""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.ts\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        ]),
    });
    const events = await collect(adapter);
    const proposal = events.find((event) => event.kind === "tool-proposal");
    expect(proposal?.kind === "tool-proposal" && proposal.name).toBe("read_file");
    expect(proposal?.kind === "tool-proposal" && proposal.argumentsJson).toBe('{"p":"a.ts"}');
    expect(events.at(-1)?.kind).toBe("finished");
  });

  test("translates assistant tool calls before matching tool results", async () => {
    let body: unknown = null;
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => "sk-test",
      fetch: async (_input, init) => {
        if (init === undefined) {
          throw new Error("expected OpenAI SDK request initialization");
        }
        body = JSON.parse(String(init.body));
        return sseResponse(['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n']);
      },
    });
    const continued = request({
      messages: [
        { role: "user", parts: [{ kind: "text", text: "read a.ts" }] },
        {
          role: "assistant",
          parts: [{ kind: "text", text: "" }],
          toolCalls: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          parts: [{ kind: "text", text: '{"status":"completed"}' }],
        },
      ],
    });
    for await (const _event of adapter.stream(continued, {
      signal: new AbortController().signal,
    })) {
      // Consume the deterministic response so the request body is observable.
    }

    expect(body).toMatchObject({
      messages: [
        { role: "user", content: "read a.ts" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: '{"status":"completed"}' },
      ],
    });
  });

  test("never puts the API key into failure messages", async () => {
    const secret = "sk-super-secret-value";
    const adapter = createOpenAiSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      resolveApiKey: async () => secret,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });
    const events = await collect(adapter);
    for (const event of events) {
      if (event.kind === "error") {
        expect(event.failure.message).not.toContain(secret);
      }
    }
  });
});
