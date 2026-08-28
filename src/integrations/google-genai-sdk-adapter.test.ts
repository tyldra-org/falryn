import { describe, expect, test } from "bun:test";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";

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

describe("createGoogleGenAiSdkAdapter", () => {
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
