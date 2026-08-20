/**
 * OpenAI-compatible adapter tests (#709).
 *
 * Uses an injectable fetch — no live network. Opt-in live tests must never be
 * required by `bun run check`.
 */

import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/index.ts";
import { modelRequestId } from "./identity.ts";
import { createOpenAiCompatibleAdapter } from "./openai-compatible-adapter.ts";
import type { ModelRequest } from "./request.ts";
import type { NormalizedProviderEvent } from "./stream.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: modelRequestId.from("req-openai-1"),
    providerId: providerId.from("openai-compatible"),
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
  adapter: ReturnType<typeof createOpenAiCompatibleAdapter>,
  init?: AbortSignal,
): Promise<readonly NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  const signal = init ?? new AbortController().signal;
  for await (const event of adapter.stream(request(), { signal })) {
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

describe("createOpenAiCompatibleAdapter", () => {
  test("streams text deltas and finishes", async () => {
    const adapter = createOpenAiCompatibleAdapter({
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

  test("classifies 429 as rate-limit", async () => {
    const adapter = createOpenAiCompatibleAdapter({
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

  test("classifies 401 as authentication", async () => {
    const adapter = createOpenAiCompatibleAdapter({
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
    const adapter = createOpenAiCompatibleAdapter({
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
    const adapter = createOpenAiCompatibleAdapter({
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
    const adapter = createOpenAiCompatibleAdapter({
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

  test("never puts the API key into failure messages", async () => {
    const secret = "sk-super-secret-value";
    const adapter = createOpenAiCompatibleAdapter({
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
