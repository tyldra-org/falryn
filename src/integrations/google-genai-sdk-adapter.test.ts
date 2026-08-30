import { describe, expect, test } from "bun:test";
import type {
  CachedContent,
  CreateCachedContentParameters,
  GenerateContentParameters,
  GenerateContentResponse,
} from "@google/genai";

import { modelId, providerId } from "../domain/index.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import {
  createGoogleGenAiSdkAdapter,
  type GoogleGenAiSdkAdapterOptions,
} from "./google-genai-sdk-adapter.ts";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: modelRequestId.from("req-google-1"),
    providerId: providerId.from("google"),
    modelId: modelId.from("gemini-test"),
    messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
    tools: [],
    output: { kind: "text" },
    budgets: {},
    metadata: { role: "default" },
    ...overrides,
  };
}

function response(value: unknown): GenerateContentResponse {
  return value as GenerateContentResponse;
}

function stream(
  responses: readonly GenerateContentResponse[],
): AsyncIterable<GenerateContentResponse> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* responses;
    },
  };
}

async function collect(
  options: Omit<GoogleGenAiSdkAdapterOptions, "profileId" | "supportedModels">,
  input: ModelRequest = request(),
): Promise<readonly NormalizedProviderEvent[]> {
  const adapter = createGoogleGenAiSdkAdapter({
    profileId: "google",
    supportedModels: ["gemini-test"],
    ...options,
  });
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.stream(input, { signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

async function collectFrom(
  adapter: ReturnType<typeof createGoogleGenAiSdkAdapter>,
  input: ModelRequest,
): Promise<readonly NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.stream(input, {
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

describe("createGoogleGenAiSdkAdapter", () => {
  test("sends the routed reasoning control", async () => {
    const captured: { request: GenerateContentParameters | null } = { request: null };
    const events = await collect(
      {
        resolveApiKey: async () => "google-test-key",
        createStream: async (_apiKey, input) => {
          captured.request = input;
          return stream([response({ candidates: [{ index: 0, finishReason: "STOP" }] })]);
        },
      },
      request({ reasoning: "balanced", reasoningControl: "medium" }),
    );
    expect(String(captured.request?.config?.thinkingConfig?.thinkingLevel)).toBe("MEDIUM");
    expect(events.at(-1)?.kind).toBe("finished");

    const unsupported = await collect(
      {
        resolveApiKey: async () => "google-test-key",
        createStream: async () =>
          stream([response({ candidates: [{ index: 0, finishReason: "STOP" }] })]),
      },
      request({ reasoning: "max", reasoningControl: "max" }),
    );
    expect(unsupported.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "unsupported-capability", retryable: false },
    });
  });

  test("normalizes text, reasoning, tool calls, usage, and finish state", async () => {
    const events = await collect({
      resolveApiKey: async () => "google-test-key",
      createStream: async () =>
        stream([
          response({
            candidates: [
              {
                index: 0,
                content: {
                  role: "model",
                  parts: [
                    { text: "check", thought: true },
                    { text: "Hi" },
                    {
                      functionCall: {
                        id: "call-1",
                        name: "read_file",
                        args: { path: "a.ts" },
                      },
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 10,
              toolUsePromptTokenCount: 2,
              candidatesTokenCount: 7,
              thoughtsTokenCount: 3,
              cachedContentTokenCount: 4,
              totalTokenCount: 22,
            },
          }),
          response({ candidates: [{ index: 0, finishReason: "STOP" }] }),
        ]),
    });

    expect(events.some((event) => event.kind === "reasoning-delta")).toBe(true);
    expect(events.some((event) => event.kind === "text-delta")).toBe(true);
    expect(events.find((event) => event.kind === "tool-proposal")).toMatchObject({
      toolCallId: "call-1",
      name: "read_file",
      argumentsJson: '{"path":"a.ts"}',
    });
    expect(events.find((event) => event.kind === "usage")).toMatchObject({
      usage: {
        provenance: "provider-reported",
        inputTokens: 12,
        outputTokens: 7,
        totalTokens: 22,
        cachedInputTokens: 4,
        reasoningTokens: 3,
      },
    });
    expect(events.at(-1)).toMatchObject({ kind: "finished", finishReason: "STOP" });
  });

  test("creates and reuses one explicit cached prefix while reporting read and write tokens", async () => {
    const cacheRequests: CreateCachedContentParameters[] = [];
    const generateRequests: GenerateContentParameters[] = [];
    const adapter = createGoogleGenAiSdkAdapter({
      profileId: "google",
      supportedModels: ["gemini-test"],
      resolveApiKey: async () => "google-test-key",
      createCache: async (_apiKey, cacheRequest) => {
        cacheRequests.push(cacheRequest);
        return {
          name: "cachedContents/falryn-prefix",
          usageMetadata: { totalTokenCount: 6 },
        } as CachedContent;
      },
      createStream: async (_apiKey, generateRequest) => {
        generateRequests.push(generateRequest);
        return stream([
          response({
            candidates: [{ index: 0, finishReason: "STOP" }],
            usageMetadata: {
              promptTokenCount: 8,
              candidatesTokenCount: 2,
              cachedContentTokenCount: 6,
              totalTokenCount: 10,
            },
          }),
        ]);
      },
    });
    const input = request({
      messages: [
        { role: "system", parts: [{ kind: "text", text: "Stable policy" }] },
        { role: "user", parts: [{ kind: "text", text: "Dynamic question" }] },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      promptCache: {
        schemaVersion: 1,
        key: `sha-256:${"a".repeat(64)}`,
        scope: "session",
        stablePrefixDigest: `sha-256:${"b".repeat(64)}`,
        stableMessageCount: 1,
        toolCatalogGeneration: 1,
        mode: "google-explicit-resource",
        minimumInputTokens: 4096,
      },
    });

    const first = await collectFrom(adapter, input);
    const second = await collectFrom(adapter, input);

    expect(cacheRequests).toHaveLength(1);
    expect(cacheRequests[0]).toMatchObject({
      model: "gemini-test",
      config: {
        ttl: "300s",
        systemInstruction: "Stable policy",
        tools: [{ functionDeclarations: [{ name: "read_file" }] }],
      },
    });
    expect(generateRequests).toHaveLength(2);
    expect(generateRequests[0]).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Dynamic question" }] }],
      config: { cachedContent: "cachedContents/falryn-prefix" },
    });
    expect(generateRequests[0]?.config?.systemInstruction).toBeUndefined();
    expect(generateRequests[0]?.config?.tools).toBeUndefined();
    expect(first.find((event) => event.kind === "usage")).toMatchObject({
      usage: { cachedInputTokens: 6, cacheWriteInputTokens: 6 },
    });
    expect(second.find((event) => event.kind === "usage")).toMatchObject({
      usage: { cachedInputTokens: 6, cacheWriteInputTokens: 0 },
    });
  });

  test("fails open to the exact request when explicit cache creation is unavailable", async () => {
    const captured: { request: GenerateContentParameters | null } = { request: null };
    const events = await collect(
      {
        resolveApiKey: async () => "google-test-key",
        createCache: async () => {
          throw new TypeError("cache endpoint unavailable");
        },
        createStream: async (_apiKey, input) => {
          captured.request = input;
          return stream([response({ candidates: [{ index: 0, finishReason: "STOP" }] })]);
        },
      },
      request({
        messages: [
          { role: "system", parts: [{ kind: "text", text: "Stable policy" }] },
          { role: "user", parts: [{ kind: "text", text: "Dynamic question" }] },
        ],
        promptCache: {
          schemaVersion: 1,
          key: `sha-256:${"c".repeat(64)}`,
          scope: "session",
          stablePrefixDigest: `sha-256:${"d".repeat(64)}`,
          stableMessageCount: 1,
          toolCatalogGeneration: 1,
          mode: "google-explicit-resource",
          minimumInputTokens: 4096,
        },
      }),
    );

    expect(captured.request).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Dynamic question" }] }],
      config: { systemInstruction: "Stable policy" },
    });
    expect(captured.request?.config?.cachedContent).toBeUndefined();
    expect(events.at(-1)?.kind).toBe("finished");
  });

  test("translates system, tools, continuations, output schema, and output budget", async () => {
    let body: GenerateContentParameters | null = null;
    const continued = request({
      messages: [
        { role: "system", parts: [{ kind: "text", text: "Follow policy" }] },
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
    });
    const events = await collect(
      {
        resolveApiKey: async () => "google-test-key",
        createStream: async (_apiKey, requestBody) => {
          body = requestBody;
          return stream([response({ candidates: [{ index: 0, finishReason: "STOP" }] })]);
        },
      },
      continued,
    );

    expect(body).toMatchObject({
      model: "gemini-test",
      config: {
        systemInstruction: "Follow policy",
        maxOutputTokens: 321,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
        tools: [
          {
            functionDeclarations: [
              {
                name: "read_file",
                parametersJsonSchema: { type: "object" },
              },
            ],
          },
        ],
      },
      contents: [
        { role: "user", parts: [{ text: "read a.ts" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call-1",
                name: "read_file",
                args: { path: "a.ts" },
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "read_file",
                response: { output: { status: "completed" } },
              },
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
        resolveApiKey: async () => "google-test-key",
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

  test("turns a safety finish reason into a typed safety failure", async () => {
    const events = await collect({
      resolveApiKey: async () => "google-test-key",
      createStream: async () =>
        stream([response({ candidates: [{ index: 0, finishReason: "SAFETY" }] })]),
    });
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "provider-safety", retryable: false },
    });
  });
});
