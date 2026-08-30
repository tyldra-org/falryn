import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/index.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import {
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  OPENAI_RESPONSES_TRANSPORT_DEFAULT,
} from "../providers/transport-compatibility.ts";
import { createOpenAiProviderAdapter } from "./openai-provider-adapter.ts";

function request(selectedModelId: string): ModelRequest {
  return {
    requestId: modelRequestId.from(`req-${selectedModelId}`),
    providerId: providerId.from("openai"),
    modelId: modelId.from(selectedModelId),
    messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
    tools: [],
    output: { kind: "text" },
    budgets: {},
    metadata: { role: "default" },
  };
}

async function collect(
  adapter: ReturnType<typeof createOpenAiProviderAdapter>,
  input: ModelRequest,
): Promise<readonly NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  for await (const item of adapter.stream(input, { signal: new AbortController().signal })) {
    events.push(item);
  }
  return events;
}

describe("createOpenAiProviderAdapter", () => {
  test("routes exact models to their immutable SDK transport plans", async () => {
    const urls: string[] = [];
    const adapter = createOpenAiProviderAdapter({
      profileId: "openai",
      baseUrl: "https://api.example.test/v1",
      supportedModels: ["chat-model", "responses-model"],
      resolveApiKey: async () => "sk-test",
      compatibility: OPENAI_CHAT_TRANSPORT_DEFAULT,
      modelCompatibility: [
        {
          schemaVersion: 1,
          modelId: modelId.from("responses-model"),
          declaration: OPENAI_RESPONSES_TRANSPORT_DEFAULT,
          source: {
            kind: "provider-documentation",
            url: "https://platform.openai.com/docs/api-reference/responses",
            observedAt: "2026-08-30T00:00:00Z",
          },
        },
      ],
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        return url.endsWith("/responses")
          ? new Response(
              `data: ${JSON.stringify({
                type: "response.completed",
                sequence_number: 1,
                response: {
                  id: "resp-1",
                  status: "completed",
                  error: null,
                  incomplete_details: null,
                  usage: null,
                },
              })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          : new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', {
              headers: { "content-type": "text/event-stream" },
            });
      },
    });

    const chat = await collect(adapter, request("chat-model"));
    const responses = await collect(adapter, request("responses-model"));

    expect(urls).toEqual([
      "https://api.example.test/v1/chat/completions",
      "https://api.example.test/v1/responses",
    ]);
    expect(chat.at(-1)).toMatchObject({ kind: "finished", finishReason: "stop" });
    expect(responses.at(-1)).toMatchObject({ kind: "finished", finishReason: "completed" });
    expect(adapter.transportCompatibilityFor(modelId.from("chat-model"))?.declaration.dialect).toBe(
      "openai-chat-completions",
    );
    expect(
      adapter.transportCompatibilityFor(modelId.from("responses-model"))?.receipt,
    ).toMatchObject({ selectedLayer: "model-override", modelId: "responses-model" });
  });
});
