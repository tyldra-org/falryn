import { describe, expect, test } from "bun:test";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";

import { modelId, providerId } from "../domain/index.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import {
  type AnthropicSdkAdapterOptions,
  createAnthropicSdkAdapter,
} from "./anthropic-sdk-adapter.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: modelRequestId.from("req-anthropic-1"),
    providerId: providerId.from("anthropic"),
    modelId: modelId.from("claude-test"),
    messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
    tools: [],
    output: { kind: "text" },
    budgets: {},
    metadata: { role: "default" },
    ...overrides,
  };
}

function stream(events: readonly RawMessageStreamEvent[]): AsyncIterable<RawMessageStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

async function collect(
  options: Omit<AnthropicSdkAdapterOptions, "profileId" | "supportedModels">,
  input: ModelRequest = request(),
): Promise<readonly NormalizedProviderEvent[]> {
  const adapter = createAnthropicSdkAdapter({
    profileId: "anthropic",
    supportedModels: ["claude-test"],
    ...options,
  });
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.stream(input, { signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

function anthropicEvent(value: unknown): RawMessageStreamEvent {
  return value as RawMessageStreamEvent;
}

describe("createAnthropicSdkAdapter", () => {
  test("sends the routed reasoning control", async () => {
    const captured: { body: MessageCreateParamsStreaming | null } = { body: null };
    const events = await collect(
      {
        resolveApiKey: async () => "sk-ant-test",
        createStream: async (_apiKey, requestBody) => {
          captured.body = requestBody;
          return stream([
            anthropicEvent({
              type: "message_start",
              message: { usage: { input_tokens: 1, output_tokens: 0 } },
            }),
            anthropicEvent({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            }),
            anthropicEvent({ type: "message_stop" }),
          ]);
        },
      },
      request({ reasoning: "deep", reasoningControl: "high" }),
    );
    expect(captured.body?.output_config).toMatchObject({ effort: "high" });
    expect(events.at(-1)?.kind).toBe("finished");

    await collect(
      {
        resolveApiKey: async () => "sk-ant-test",
        createStream: async (_apiKey, requestBody) => {
          captured.body = requestBody;
          return stream([
            anthropicEvent({
              type: "message_start",
              message: { usage: { input_tokens: 1, output_tokens: 0 } },
            }),
            anthropicEvent({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            }),
            anthropicEvent({ type: "message_stop" }),
          ]);
        },
      },
      request({ reasoning: "max", reasoningControl: "max" }),
    );
    expect(captured.body?.output_config).toMatchObject({ effort: "max" });
  });

  test("normalizes text, reasoning, tool calls, usage, and finish state", async () => {
    const events = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () =>
        stream([
          anthropicEvent({
            type: "message_start",
            message: {
              usage: {
                input_tokens: 10,
                output_tokens: 0,
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 5,
              },
            },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "check" },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Hi" },
          }),
          anthropicEvent({
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: {},
              caller: { type: "direct" },
            },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
          }),
          anthropicEvent({ type: "content_block_stop", index: 2 }),
          anthropicEvent({
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 7 },
          }),
          anthropicEvent({ type: "message_stop" }),
        ]),
    });

    expect(events.some((event) => event.kind === "reasoning-delta")).toBe(true);
    expect(events.some((event) => event.kind === "text-delta")).toBe(true);
    expect(events.find((event) => event.kind === "tool-proposal")).toMatchObject({
      toolCallId: "toolu_1",
      name: "read_file",
      argumentsJson: '{"path":"a.ts"}',
    });
    expect(events.find((event) => event.kind === "usage")).toMatchObject({
      usage: {
        provenance: "provider-reported",
        inputTokens: 18,
        outputTokens: 7,
        totalTokens: 25,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 3,
      },
    });
    expect(events.at(-1)).toMatchObject({ kind: "finished", finishReason: "tool_use" });
  });

  test("translates system, tools, continuations, output schema, and output budget", async () => {
    let body: MessageCreateParamsStreaming | null = null;
    const continued = request({
      messages: [
        { role: "system", parts: [{ kind: "text", text: "Follow policy" }] },
        { role: "system", parts: [{ kind: "text", text: "Keep it concise" }] },
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
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      output: {
        kind: "json-schema",
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
      budgets: { maxOutputTokens: 321 },
      promptCache: {
        schemaVersion: 1,
        key: `sha-256:${"d".repeat(64)}`,
        scope: "session",
        stablePrefixDigest: `sha-256:${"e".repeat(64)}`,
        stableMessageCount: 1,
        toolCatalogGeneration: 1,
        mode: "anthropic-ephemeral",
        minimumInputTokens: 1024,
      },
    });
    const events = await collect(
      {
        resolveApiKey: async () => "sk-ant-test",
        createStream: async (_apiKey, requestBody) => {
          body = requestBody;
          return stream([
            anthropicEvent({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 1 },
            }),
            anthropicEvent({ type: "message_stop" }),
          ]);
        },
      },
      continued,
    );

    expect(body).toMatchObject({
      model: "claude-test",
      max_tokens: 321,
      system: [
        {
          type: "text",
          text: "Follow policy",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
        { type: "text", text: "Keep it concise" },
      ],
      tools: [
        {
          name: "read_file",
          input_schema: { type: "object" },
        },
      ],
      output_config: { format: { type: "json_schema" } },
      messages: [
        { role: "user", content: "read a.ts" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "read_file",
              input: { path: "a.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: '{"status":"completed"}',
            },
          ],
        },
      ],
    });
    expect(events.at(-1)?.kind).toBe("finished");
  });

  test("fails closed for missing credentials and unresolved image handles", async () => {
    const missing = await collect({
      resolveApiKey: async () => null,
      createStream: async () => {
        throw new Error("must not execute");
      },
    });
    expect(missing.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "authentication", retryable: false },
    });

    const image = await collect(
      {
        resolveApiKey: async () => "sk-ant-test",
        createStream: async () => {
          throw new Error("must not execute");
        },
      },
      request({
        messages: [
          {
            role: "user",
            parts: [{ kind: "image", handle: "artifact:image-1", mediaType: "image/png" }],
          },
        ],
      }),
    );
    expect(image.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "unsupported-capability", retryable: false },
    });
  });

  test("turns a provider refusal into a typed safety failure", async () => {
    const events = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () =>
        stream([
          anthropicEvent({
            type: "message_delta",
            delta: { stop_reason: "refusal" },
            usage: { output_tokens: 1 },
          }),
          anthropicEvent({ type: "message_stop" }),
        ]),
    });
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "provider-safety", retryable: false },
    });
  });
});
