import { describe, expect, test } from "bun:test";
import { APIConnectionTimeoutError, APIUserAbortError, RateLimitError } from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";

import { modelId, providerId } from "../domain/index.ts";
import type {
  ProviderContinuationStatePort,
  ProviderContinuationStateRecord,
} from "../providers/continuation-state.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import { ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT } from "../providers/transport-compatibility.ts";
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

function continuationStore(): {
  readonly port: ProviderContinuationStatePort;
  readonly records: Map<string, ProviderContinuationStateRecord>;
} {
  const records = new Map<string, ProviderContinuationStateRecord>();
  const keyOf = (value: {
    readonly profileId: string;
    readonly destinationId: string;
    readonly transportCompatibilityId: string;
    readonly modelId: unknown;
    readonly toolCallId: string;
  }): string =>
    [
      value.profileId,
      value.destinationId,
      value.transportCompatibilityId,
      String(value.modelId),
      value.toolCallId,
    ].join("\0");
  return {
    records,
    port: {
      load(key) {
        return { ok: true, value: records.get(keyOf(key)) ?? null };
      },
      save(values) {
        let inserted = 0;
        let replaced = 0;
        for (const value of values) {
          const key = keyOf(value);
          if (records.has(key)) {
            replaced += 1;
          } else {
            inserted += 1;
          }
          records.set(key, value);
        }
        return { ok: true, value: { inserted, replaced } };
      },
    },
  };
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
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "check" },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "signed-thinking" },
          }),
          anthropicEvent({ type: "content_block_stop", index: 0 }),
          anthropicEvent({
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "", citations: null },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Hi" },
          }),
          anthropicEvent({ type: "content_block_stop", index: 1 }),
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
            usage: {
              output_tokens: 7,
              output_tokens_details: { thinking_tokens: 4 },
            },
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
        reasoningTokens: 4,
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
        modelCompatibility: [
          {
            schemaVersion: 1,
            modelId: modelId.from("claude-test"),
            declaration: { ...ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT, promptCacheTtl: "1h" },
            source: {
              kind: "provider-documentation",
              url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
              observedAt: "2026-08-30T00:00:00Z",
            },
          },
        ],
        createStream: async (_apiKey, requestBody) => {
          body = requestBody;
          return stream([
            anthropicEvent({
              type: "message_start",
              message: { usage: { input_tokens: 1, output_tokens: 0 } },
            }),
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
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        { type: "text", text: "Keep it concise" },
      ],
      tools: [
        {
          name: "read_file",
          input_schema: { type: "object" },
          strict: true,
        },
      ],
      output_config: { format: { type: "json_schema" } },
      service_tier: "auto",
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

  test("retains signed thinking and replays it after an adapter restart", async () => {
    const durable = continuationStore();
    const base = request({
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    const first = await collect(
      {
        continuationState: durable.port,
        now: () => 42,
        resolveApiKey: async () => "sk-ant-test",
        createStream: async () =>
          stream([
            anthropicEvent({
              type: "message_start",
              message: { usage: { input_tokens: 9, output_tokens: 0 } },
            }),
            anthropicEvent({
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "", signature: "" },
            }),
            anthropicEvent({
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "inspect the file" },
            }),
            anthropicEvent({
              type: "content_block_delta",
              index: 0,
              delta: { type: "signature_delta", signature: "signed-reasoning" },
            }),
            anthropicEvent({ type: "content_block_stop", index: 0 }),
            anthropicEvent({
              type: "content_block_start",
              index: 1,
              content_block: { type: "redacted_thinking", data: "opaque-redacted" },
            }),
            anthropicEvent({ type: "content_block_stop", index: 1 }),
            anthropicEvent({
              type: "content_block_start",
              index: 2,
              content_block: {
                type: "tool_use",
                id: "toolu_restart",
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
              usage: { output_tokens: 11 },
            }),
            anthropicEvent({ type: "message_stop" }),
          ]),
      },
      base,
    );

    expect(first).toContainEqual(
      expect.objectContaining({
        kind: "provider-metadata",
        entries: { continuationStateSaved: "true", continuationStateSavedCount: "1" },
      }),
    );
    expect(durable.records.size).toBe(1);
    expect([...durable.records.values()][0]?.capturedAt).toBe(42);

    const continued: { body: MessageCreateParamsStreaming | null } = { body: null };
    const second = await collect(
      {
        continuationState: durable.port,
        resolveApiKey: async () => "sk-ant-test",
        createStream: async (_apiKey, body) => {
          continued.body = body;
          return stream([
            anthropicEvent({
              type: "message_start",
              message: { usage: { input_tokens: 12, output_tokens: 0 } },
            }),
            anthropicEvent({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            }),
            anthropicEvent({ type: "message_stop" }),
          ]);
        },
      },
      {
        ...base,
        requestId: modelRequestId.from("req-anthropic-after-restart"),
        messages: [
          ...base.messages,
          {
            role: "assistant",
            parts: [],
            toolCalls: [
              { toolCallId: "toolu_restart", name: "read_file", arguments: { path: "a.ts" } },
            ],
          },
          {
            role: "tool",
            toolCallId: "toolu_restart",
            parts: [{ kind: "text", text: "file contents" }],
          },
        ],
      },
    );

    expect(second).toContainEqual(
      expect.objectContaining({
        kind: "provider-metadata",
        entries: { continuationStateLoaded: "true", continuationStateLoadedCount: "1" },
      }),
    );
    expect(continued.body?.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inspect the file", signature: "signed-reasoning" },
        { type: "redacted_thinking", data: "opaque-redacted" },
        { type: "tool_use", id: "toolu_restart", name: "read_file" },
      ],
    });
    expect(JSON.stringify(second)).not.toContain("opaque-redacted");
    expect(second.at(-1)).toMatchObject({ kind: "finished", finishReason: "end_turn" });
  });

  test("fails closed for incompatible identity, tool ordering, and malformed streams", async () => {
    const mismatched = await collect(
      {
        resolveApiKey: async () => "sk-ant-test",
        createStream: async () => {
          throw new Error("must not execute");
        },
      },
      request({ metadata: { role: "default", transportCompatibilityId: "sha-256:wrong" } }),
    );
    expect(mismatched.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "invalid-request", retryable: false },
    });

    const missingToolResult = await collect(
      {
        resolveApiKey: async () => "sk-ant-test",
        createStream: async () => {
          throw new Error("must not execute");
        },
      },
      request({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "read" }] },
          {
            role: "assistant",
            parts: [],
            toolCalls: [{ toolCallId: "toolu_missing", name: "read_file", arguments: {} }],
          },
        ],
      }),
    );
    expect(missingToolResult.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "invalid-request", retryable: false },
    });

    const malformed = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () =>
        stream([
          anthropicEvent({
            type: "message_start",
            message: { usage: { input_tokens: 1, output_tokens: 0 } },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "orphan" },
          }),
        ]),
    });
    expect(malformed.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "malformed-stream", retryable: false },
    });

    const partial = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () =>
        stream([
          anthropicEvent({
            type: "message_start",
            message: { usage: { input_tokens: 1, output_tokens: 0 } },
          }),
          anthropicEvent({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "", citations: null },
          }),
          anthropicEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          }),
          anthropicEvent({ type: "content_block_stop", index: 0 }),
        ]),
    });
    expect(partial.some((event) => event.kind === "text-delta" && event.text === "partial")).toBe(
      true,
    );
    expect(partial.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "malformed-stream", retryable: false },
    });
  });

  test("preserves provider retry timing without exposing response data", async () => {
    const events = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () => {
        throw new RateLimitError(
          429,
          {},
          "provider details",
          new Headers({ "retry-after-ms": "1750" }),
        );
      },
    });
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "rate-limit", retryable: true, retryAfterMs: 1750 },
    });
    expect(JSON.stringify(events)).not.toContain("provider details");
  });

  test("normalizes SDK timeout and cancellation failures", async () => {
    const timedOut = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () => {
        throw new APIConnectionTimeoutError();
      },
    });
    expect(timedOut.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "timeout", retryable: true },
    });

    const cancelled = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () => {
        throw new APIUserAbortError();
      },
    });
    expect(cancelled.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "cancellation", retryable: false },
    });
  });

  test("turns a provider refusal into a typed safety failure", async () => {
    const events = await collect({
      resolveApiKey: async () => "sk-ant-test",
      createStream: async () =>
        stream([
          anthropicEvent({
            type: "message_start",
            message: { usage: { input_tokens: 1, output_tokens: 0 } },
          }),
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
