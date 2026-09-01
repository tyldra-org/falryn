import { describe, expect, test } from "bun:test";
import {
  ApiError,
  type CreateCachedContentParameters,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";

import { modelId, providerId } from "../domain/index.ts";
import type {
  ProviderContinuationStatePort,
  ProviderContinuationStateRecord,
} from "../providers/continuation-state.ts";
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

function continuationStore(): {
  readonly port: ProviderContinuationStatePort;
  readonly records: Map<string, ProviderContinuationStateRecord>;
} {
  const records = new Map<string, ProviderContinuationStateRecord>();
  const key = (record: {
    readonly profileId: string;
    readonly providerId: string;
    readonly destinationId: string;
    readonly transportCompatibilityId: string;
    readonly modelId: string;
    readonly toolCallId: string;
  }): string =>
    [
      record.profileId,
      record.providerId,
      record.destinationId,
      record.transportCompatibilityId,
      record.modelId,
      record.toolCallId,
    ].join("\u0000");
  return {
    records,
    port: {
      load(input) {
        return { ok: true, value: records.get(key(input)) ?? null };
      },
      save(input) {
        let inserted = 0;
        let replaced = 0;
        for (const record of input) {
          const id = key(record);
          if (records.has(id)) {
            replaced += 1;
          } else {
            inserted += 1;
          }
          records.set(id, record);
        }
        return { ok: true, value: { inserted, replaced } };
      },
    },
  };
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

  test("uses a bound explicit cached prefix and reports provider read and write tokens", async () => {
    const cacheRequests: CreateCachedContentParameters[] = [];
    const generateRequests: GenerateContentParameters[] = [];
    let cacheResolution = 0;
    const adapter = createGoogleGenAiSdkAdapter({
      profileId: "google",
      supportedModels: ["gemini-test"],
      resolveApiKey: async () => "google-test-key",
      cachedContent: {
        async resolve(input) {
          cacheRequests.push(input.create);
          cacheResolution += 1;
          return {
            kind: "bound",
            name: "cachedContents/falryn-prefix",
            cacheWriteInputTokens: cacheResolution === 1 ? 6 : 0,
          };
        },
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

    expect(cacheRequests).toHaveLength(2);
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
        cachedContent: {
          async resolve() {
            throw new TypeError("cache endpoint unavailable");
          },
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
        automaticFunctionCalling: { disable: true },
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

  test("persists and replays signed thought state across adapter restart", async () => {
    const durable = continuationStore();
    const firstAdapter = createGoogleGenAiSdkAdapter({
      profileId: "google",
      supportedModels: ["gemini-test"],
      resolveApiKey: async () => "google-test-key",
      continuationState: durable.port,
      now: () => 123,
      createStream: async () =>
        stream([
          response({
            candidates: [
              {
                index: 0,
                content: {
                  role: "model",
                  parts: [
                    {
                      text: "private reasoning",
                      thought: true,
                      thoughtSignature: "thought-signature",
                    },
                    {
                      functionCall: {
                        id: "call-signed",
                        name: "read_file",
                        args: { path: "a.ts" },
                      },
                      thoughtSignature: "function-signature",
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          }),
        ]),
    });
    const firstEvents = await collectFrom(firstAdapter, request());
    expect(firstEvents.find((event) => event.kind === "provider-metadata")).toMatchObject({
      entries: { continuationStateSaved: "true", continuationStateSavedCount: "1" },
    });
    expect(JSON.stringify(firstEvents)).not.toContain("thought-signature");
    expect(JSON.stringify(firstEvents)).not.toContain("function-signature");
    expect(durable.records.size).toBe(1);

    const continuedRequest: { value: GenerateContentParameters | null } = { value: null };
    const restartedAdapter = createGoogleGenAiSdkAdapter({
      profileId: "google",
      supportedModels: ["gemini-test"],
      resolveApiKey: async () => "google-test-key",
      continuationState: durable.port,
      createStream: async (_apiKey, input) => {
        continuedRequest.value = input;
        return stream([response({ candidates: [{ index: 0, finishReason: "STOP" }] })]);
      },
    });
    const continued = request({
      messages: [
        { role: "user", parts: [{ kind: "text", text: "read a.ts" }] },
        {
          role: "assistant",
          parts: [{ kind: "text", text: "" }],
          toolCalls: [
            { toolCallId: "call-signed", name: "read_file", arguments: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-signed",
          parts: [{ kind: "text", text: '{"status":"completed"}' }],
        },
      ],
    });
    const continuedEvents = await collectFrom(restartedAdapter, continued);

    expect(continuedEvents.find((event) => event.kind === "provider-metadata")).toMatchObject({
      entries: { continuationStateLoaded: "true", continuationStateLoadedCount: "1" },
    });
    expect(continuedRequest.value?.contents).toMatchObject([
      { role: "user", parts: [{ text: "read a.ts" }] },
      {
        role: "model",
        parts: [
          {
            text: "private reasoning",
            thought: true,
            thoughtSignature: "thought-signature",
          },
          {
            functionCall: { id: "call-signed", name: "read_file" },
            thoughtSignature: "function-signature",
          },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { id: "call-signed", name: "read_file" } }],
      },
    ]);
    expect(continuedEvents.at(-1)?.kind).toBe("finished");
  });

  test("rejects multi-candidate, post-terminal, and malformed usage streams", async () => {
    const multi = await collect({
      resolveApiKey: async () => "google-test-key",
      createStream: async () =>
        stream([
          response({
            candidates: [
              { index: 0, finishReason: "STOP" },
              { index: 1, finishReason: "STOP" },
            ],
          }),
        ]),
    });
    expect(multi.at(-1)).toMatchObject({ kind: "error", failure: { kind: "malformed-stream" } });

    const postTerminal = await collect({
      resolveApiKey: async () => "google-test-key",
      createStream: async () =>
        stream([
          response({ candidates: [{ index: 0, finishReason: "STOP" }] }),
          response({
            candidates: [{ index: 0, content: { role: "model", parts: [{ text: "late" }] } }],
          }),
        ]),
    });
    expect(postTerminal.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "malformed-stream" },
    });

    const invalidUsage = await collect({
      resolveApiKey: async () => "google-test-key",
      createStream: async () =>
        stream([
          response({
            candidates: [{ index: 0, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 11 },
          }),
        ]),
    });
    expect(invalidUsage.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "malformed-stream" },
    });
  });

  test("rejects transport identity drift and invalid message ordering before SDK execution", async () => {
    let executions = 0;
    const options = {
      resolveApiKey: async () => "google-test-key",
      createStream: async () => {
        executions += 1;
        return stream([response({ candidates: [{ index: 0, finishReason: "STOP" }] })]);
      },
    } satisfies Omit<GoogleGenAiSdkAdapterOptions, "profileId" | "supportedModels">;

    const drift = await collect(
      options,
      request({ metadata: { role: "default", transportCompatibilityId: "sha-256:wrong" } }),
    );
    expect(drift.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "invalid-request", retryable: false },
    });

    const misplacedSystem = await collect(
      options,
      request({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "hello" }] },
          { role: "system", parts: [{ kind: "text", text: "late policy" }] },
        ],
      }),
    );
    expect(misplacedSystem.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "invalid-request", retryable: false },
    });

    const orphanResult = await collect(
      options,
      request({
        messages: [
          { role: "user", parts: [{ kind: "text", text: "hello" }] },
          {
            role: "tool",
            toolCallId: "missing-call",
            parts: [{ kind: "text", text: "contents" }],
          },
        ],
      }),
    );
    expect(orphanResult.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "invalid-request", retryable: false },
    });
    expect(executions).toBe(0);
  });

  test("normalizes SDK rate limits and cancellation without exposing provider details", async () => {
    const rateLimited = await collect({
      resolveApiKey: async () => "google-test-key",
      createStream: async () => {
        throw new ApiError({ status: 429, message: "secret provider detail" });
      },
    });
    expect(rateLimited.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "rate-limit", retryable: true },
    });
    expect(JSON.stringify(rateLimited)).not.toContain("secret provider detail");

    let credentialReads = 0;
    const adapter = createGoogleGenAiSdkAdapter({
      profileId: "google",
      supportedModels: ["gemini-test"],
      resolveApiKey: async () => {
        credentialReads += 1;
        return "google-test-key";
      },
      createStream: async () => {
        throw new Error("must not execute");
      },
    });
    const controller = new AbortController();
    controller.abort();
    const events: NormalizedProviderEvent[] = [];
    for await (const event of adapter.stream(request(), { signal: controller.signal })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "cancellation", retryable: false },
    });
    expect(credentialReads).toBe(0);
  });
});
