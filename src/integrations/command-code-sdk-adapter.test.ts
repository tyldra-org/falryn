import { describe, expect, test } from "bun:test";

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import { createCommandCodeSdkAdapter } from "./command-code-sdk-adapter.ts";

function request(model: string, overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: modelRequestId.from(`request-${model.replaceAll("/", "-")}`),
    providerId: providerId.from("commandcode"),
    modelId: modelId.from(model),
    messages: [{ role: "user", parts: [{ kind: "text", text: "hello" }] }],
    tools: [],
    output: { kind: "text" },
    budgets: {},
    metadata: { role: "default" },
    ...overrides,
  };
}

function child(name: "openai" | "anthropic", calls: string[]): ProviderAdapterPort {
  return {
    identity: {
      providerId: providerId.from("commandcode"),
      profileId: `commandcode-${name}`,
      adapterKind: name,
      endpoint: null,
      destinationId: `test-${name}`,
      displayName: name,
    },
    supportedModels: [],
    requestInputModalities: ["text"],
    async *stream(input): AsyncIterable<NormalizedProviderEvent> {
      calls.push(name);
      yield {
        kind: "request-started",
        requestId: input.requestId,
        modelAttemptId: modelAttemptId.from(`attempt-${input.requestId}`),
        sequence: 1,
      };
    },
  };
}

async function collect(
  adapter: ProviderAdapterPort,
  input: ModelRequest,
): Promise<readonly NormalizedProviderEvent[]> {
  const events: NormalizedProviderEvent[] = [];
  for await (const event of adapter.stream(input, { signal: new AbortController().signal })) {
    events.push(event);
  }
  return events;
}

describe("createCommandCodeSdkAdapter", () => {
  test("routes exact model IDs through their documented provider protocol", async () => {
    const calls: string[] = [];
    const adapter = createCommandCodeSdkAdapter(
      {
        profileId: "commandcode",
        resolveApiKey: async () => "secret",
        supportedModels: ["gpt-5.6-sol", "claude-sonnet-5", "unknown-model"],
      },
      () => ({
        openai: child("openai", calls),
        anthropic: child("anthropic", calls),
      }),
    );

    expect(adapter.identity).toMatchObject({
      providerId: "commandcode",
      adapterKind: "commandcode",
      endpoint: "https://api.commandcode.ai/provider/v1",
    });
    expect(adapter.supportedModels.map(String)).toEqual(["gpt-5.6-sol", "claude-sonnet-5"]);

    await collect(adapter, request("gpt-5.6-sol"));
    await collect(adapter, request("claude-sonnet-5"));
    expect(calls).toEqual(["openai", "anthropic"]);
  });

  test("fails closed when an unverified model reaches the adapter", async () => {
    const adapter = createCommandCodeSdkAdapter(
      {
        profileId: "commandcode",
        resolveApiKey: async () => "secret",
        supportedModels: ["unknown-model"],
      },
      () => ({ openai: child("openai", []), anthropic: child("anthropic", []) }),
    );

    const events = await collect(adapter, request("unknown-model"));
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "unsupported-capability", retryable: false },
    });
  });

  test("does not inherit OpenAI-native verbosity from a compatible wire protocol", async () => {
    const calls: string[] = [];
    const adapter = createCommandCodeSdkAdapter(
      {
        profileId: "commandcode",
        resolveApiKey: async () => "secret",
        supportedModels: ["gpt-5.6-sol"],
      },
      () => ({ openai: child("openai", calls), anthropic: child("anthropic", calls) }),
    );

    expect(adapter.requestResponseDensityControls).toEqual([]);
    const events = await collect(
      adapter,
      request("gpt-5.6-sol", { responseDensityControl: "low" }),
    );
    expect(calls).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "unsupported-capability", retryable: false },
    });
  });
});
