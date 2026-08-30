/** OpenAI Responses transport conformance tests with SDK-injected HTTP fixtures. */

import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/index.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import { OPENAI_RESPONSES_TRANSPORT_DEFAULT } from "../providers/transport-compatibility.ts";
import { createOpenAiResponsesSdkAdapter } from "./openai-responses-sdk-adapter.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: modelRequestId.from("req-responses-1"),
    providerId: providerId.from("openai"),
    modelId: modelId.from("gpt-test"),
    messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
    tools: [],
    output: { kind: "text" },
    budgets: {},
    metadata: { role: "default" },
    ...overrides,
  };
}

async function collect(
  adapter: ReturnType<typeof createOpenAiResponsesSdkAdapter>,
  input: ModelRequest = request(),
  signal = new AbortController().signal,
): Promise<readonly NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.stream(input, { signal })) {
    events.push(event);
  }
  return events;
}

function event(value: object): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function sseResponse(events: readonly object[]): Response {
  return new Response(events.map(event).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function response(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 2_048,
    model: "gpt-test",
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt: null,
    reasoning: { effort: "medium", summary: "auto" },
    safety_identifier: null,
    service_tier: "default",
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_logprobs: 0,
    top_p: null,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
    ...overrides,
  };
}

describe("createOpenAiResponsesSdkAdapter", () => {
  test("translates controls and normalizes text, reasoning, and usage", async () => {
    let body: Record<string, unknown> | null = null;
    let url = "";
    const adapter = createOpenAiResponsesSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["gpt-test"],
      resolveApiKey: async () => "sk-test",
      compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
      fetch: async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse([
          {
            type: "response.output_text.delta",
            sequence_number: 1,
            item_id: "msg-1",
            output_index: 0,
            content_index: 0,
            delta: "Hi",
            logprobs: [],
          },
          {
            type: "response.reasoning_summary_text.delta",
            sequence_number: 2,
            item_id: "rs-1",
            output_index: 0,
            summary_index: 0,
            delta: "Checked.",
          },
          {
            type: "response.completed",
            sequence_number: 3,
            response: response("resp-1", {
              usage: {
                input_tokens: 11,
                input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
                output_tokens: 3,
                output_tokens_details: { reasoning_tokens: 1 },
                total_tokens: 14,
              },
            }),
          },
        ]);
      },
    });

    const events = await collect(
      adapter,
      request({
        messages: [
          { role: "system", parts: [{ kind: "text", text: "policy" }] },
          { role: "user", parts: [{ kind: "text", text: "hello" }] },
        ],
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
          name: "result",
          schema: { type: "object", additionalProperties: false },
        },
        budgets: { maxOutputTokens: 2_048 },
        reasoningControl: "medium",
        responseDensityControl: "low",
        promptCache: {
          schemaVersion: 1,
          key: `sha-256:${"a".repeat(64)}`,
          scope: "session",
          stablePrefixDigest: `sha-256:${"b".repeat(64)}`,
          stableMessageCount: 1,
          toolCatalogGeneration: 1,
          mode: "openai-routing-key",
          minimumInputTokens: 1_024,
        },
      }),
    );

    expect(url).toEndWith("/responses");
    expect(body).toMatchObject({
      model: "gpt-test",
      stream: true,
      store: false,
      service_tier: "auto",
      input: [
        { role: "developer", content: "policy" },
        { role: "user", content: "hello" },
      ],
      max_output_tokens: 2_048,
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium", summary: "auto" },
      text: {
        verbosity: "low",
        format: { type: "json_schema", name: "result", strict: true },
      },
      tools: [{ type: "function", name: "read_file", strict: true }],
      prompt_cache_key: `sha-256:${"a".repeat(64)}`,
    });
    expect(events.find((item) => item.kind === "text-delta")).toMatchObject({ text: "Hi" });
    expect(events.find((item) => item.kind === "reasoning-delta")).toMatchObject({
      text: "Checked.",
    });
    expect(events.find((item) => item.kind === "usage")).toMatchObject({
      usage: {
        inputTokens: 11,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
        totalTokens: 14,
      },
    });
    expect(events.at(-1)).toMatchObject({ kind: "finished", finishReason: "completed" });
    expect(JSON.stringify(body)).not.toContain("sk-test");
  });

  test("replays completed reasoning before a stateless tool continuation", async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const adapter = createOpenAiResponsesSdkAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["gpt-test"],
      resolveApiKey: async () => "sk-test",
      compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        call += 1;
        if (call === 1) {
          const reasoning = {
            id: "rs-1",
            type: "reasoning",
            encrypted_content: "opaque-provider-state",
            summary: [],
            status: "completed",
          };
          const functionCall = {
            id: "fc-1",
            type: "function_call",
            call_id: "call-1",
            name: "read_file",
            arguments: '{"path":"a.ts"}',
            status: "completed",
          };
          return sseResponse([
            {
              type: "response.output_item.done",
              sequence_number: 1,
              output_index: 0,
              item: reasoning,
            },
            {
              type: "response.output_item.added",
              sequence_number: 2,
              output_index: 1,
              item: { ...functionCall, arguments: "", status: "in_progress" },
            },
            {
              type: "response.function_call_arguments.delta",
              sequence_number: 3,
              item_id: "fc-1",
              output_index: 1,
              delta: '{"path":',
            },
            {
              type: "response.function_call_arguments.delta",
              sequence_number: 4,
              item_id: "fc-1",
              output_index: 1,
              delta: '"a.ts"}',
            },
            {
              type: "response.function_call_arguments.done",
              sequence_number: 5,
              item_id: "fc-1",
              output_index: 1,
              name: "read_file",
              arguments: '{"path":"a.ts"}',
            },
            {
              type: "response.output_item.done",
              sequence_number: 6,
              output_index: 1,
              item: functionCall,
            },
            {
              type: "response.completed",
              sequence_number: 7,
              response: response("resp-tools", { output: [reasoning, functionCall] }),
            },
          ]);
        }
        return sseResponse([
          {
            type: "response.completed",
            sequence_number: 1,
            response: response("resp-finished"),
          },
        ]);
      },
    });

    const first = await collect(
      adapter,
      request({
        tools: [
          {
            name: "read_file",
            description: "Read a file.",
            parameters: { type: "object", additionalProperties: false },
          },
        ],
      }),
    );
    expect(first.find((item) => item.kind === "tool-proposal")).toMatchObject({
      toolCallId: "call-1",
      name: "read_file",
      argumentsJson: '{"path":"a.ts"}',
    });

    await collect(
      adapter,
      request({
        requestId: modelRequestId.from("req-responses-2"),
        messages: [
          { role: "user", parts: [{ kind: "text", text: "read a.ts" }] },
          {
            role: "assistant",
            parts: [],
            toolCalls: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
          },
          {
            role: "tool",
            toolCallId: "call-1",
            parts: [{ kind: "text", text: "contents" }],
          },
        ],
      }),
    );

    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    expect(bodies[1]?.input).toEqual([
      { role: "user", content: "read a.ts" },
      {
        id: "rs-1",
        type: "reasoning",
        encrypted_content: "opaque-provider-state",
        summary: [],
        status: "completed",
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      },
      { type: "function_call_output", call_id: "call-1", output: "contents" },
    ]);
  });

  test("uses provider state only when the explicit plan enables it", async () => {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const adapter = createOpenAiResponsesSdkAdapter({
      profileId: "openai-stateful",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["gpt-test"],
      resolveApiKey: async () => "sk-test",
      compatibility: {
        ...OPENAI_RESPONSES_TRANSPORT_DEFAULT,
        continuation: "previous-response",
        store: true,
        includeEncryptedReasoning: false,
      },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        call += 1;
        const functionCall = {
          id: "fc-stateful",
          type: "function_call",
          call_id: "call-stateful",
          name: "read_file",
          arguments: "{}",
          status: "completed",
        };
        return call === 1
          ? sseResponse([
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
                response: response("resp-stateful", { store: true, output: [functionCall] }),
              },
            ])
          : sseResponse([
              {
                type: "response.completed",
                sequence_number: 1,
                response: response("resp-after-stateful", { store: true }),
              },
            ]);
      },
    });

    await collect(adapter);
    await collect(
      adapter,
      request({
        requestId: modelRequestId.from("req-stateful-2"),
        messages: [
          { role: "user", parts: [{ kind: "text", text: "read" }] },
          {
            role: "assistant",
            parts: [],
            toolCalls: [{ toolCallId: "call-stateful", name: "read_file", arguments: {} }],
          },
          {
            role: "tool",
            toolCallId: "call-stateful",
            parts: [{ kind: "text", text: "done" }],
          },
        ],
      }),
    );

    expect(bodies[0]).toMatchObject({ store: true });
    expect(bodies[0]).not.toHaveProperty("include");
    expect(bodies[1]).toMatchObject({
      store: true,
      previous_response_id: "resp-stateful",
      input: [{ type: "function_call_output", call_id: "call-stateful", output: "done" }],
    });
  });

  test("fails closed for a missing credential and nonterminal stream", async () => {
    const missing = createOpenAiResponsesSdkAdapter({
      profileId: "missing",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["gpt-test"],
      resolveApiKey: async () => null,
      compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
    });
    expect((await collect(missing)).at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "authentication", retryable: false },
    });

    const malformed = createOpenAiResponsesSdkAdapter({
      profileId: "malformed",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["gpt-test"],
      resolveApiKey: async () => "sk-test",
      compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
      fetch: async () => sseResponse([]),
    });
    expect((await collect(malformed)).at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "malformed-stream", retryable: false },
    });
  });

  test("rejects duplicate tool-call identities before a terminal result", async () => {
    const adapter = createOpenAiResponsesSdkAdapter({
      profileId: "duplicate-tool",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["gpt-test"],
      resolveApiKey: async () => "sk-test",
      compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
      fetch: async () => {
        const item = (id: string) => ({
          id,
          type: "function_call",
          call_id: "duplicate-call",
          name: "read_file",
          arguments: "{}",
          status: "completed",
        });
        return sseResponse([
          {
            type: "response.output_item.added",
            sequence_number: 1,
            output_index: 0,
            item: { ...item("fc-1"), arguments: "", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 2,
            output_index: 0,
            item: item("fc-1"),
          },
          {
            type: "response.output_item.added",
            sequence_number: 3,
            output_index: 1,
            item: { ...item("fc-2"), arguments: "", status: "in_progress" },
          },
          {
            type: "response.output_item.done",
            sequence_number: 4,
            output_index: 1,
            item: item("fc-2"),
          },
          {
            type: "response.completed",
            sequence_number: 5,
            response: response("resp-duplicate"),
          },
        ]);
      },
    });

    expect((await collect(adapter)).at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "malformed-stream", retryable: false },
    });
  });

  test("normalizes incomplete, refusal, failed, and cancellation outcomes", async () => {
    const fixtures: Array<{
      readonly profileId: string;
      readonly events: readonly object[];
      readonly expected: object;
    }> = [
      {
        profileId: "incomplete",
        events: [
          {
            type: "response.incomplete",
            sequence_number: 1,
            response: response("resp-incomplete", {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            }),
          },
        ],
        expected: { kind: "finished", finishReason: "incomplete:max_output_tokens" },
      },
      {
        profileId: "refusal",
        events: [
          {
            type: "response.refusal.delta",
            sequence_number: 1,
            item_id: "msg-1",
            output_index: 0,
            content_index: 0,
            delta: "Unable.",
          },
          {
            type: "response.completed",
            sequence_number: 2,
            response: response("resp-refusal"),
          },
        ],
        expected: { kind: "error", failure: { kind: "provider-safety", retryable: false } },
      },
      {
        profileId: "failed",
        events: [
          {
            type: "response.failed",
            sequence_number: 1,
            response: response("resp-failed", {
              status: "failed",
              error: { code: "server_error", message: "secret provider detail" },
            }),
          },
        ],
        expected: { kind: "error", failure: { kind: "server-failure", retryable: true } },
      },
    ];

    for (const fixture of fixtures) {
      const adapter = createOpenAiResponsesSdkAdapter({
        profileId: fixture.profileId,
        baseUrl: "https://api.example.test/v1",
        supportedModels: ["gpt-test"],
        resolveApiKey: async () => "sk-test",
        compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
        fetch: async () => sseResponse(fixture.events),
      });
      const events = await collect(adapter);
      expect(events.at(-1)).toMatchObject(fixture.expected);
      expect(JSON.stringify(events)).not.toContain("secret provider detail");
    }

    const cancelled = createOpenAiResponsesSdkAdapter({
      profileId: "cancelled",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["gpt-test"],
      resolveApiKey: async () => "sk-test",
      compatibility: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
    });
    const controller = new AbortController();
    controller.abort();
    expect((await collect(cancelled, request(), controller.signal)).at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "cancellation", retryable: false },
    });
  });
});
