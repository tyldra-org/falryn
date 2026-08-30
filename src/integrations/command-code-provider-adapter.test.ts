import { describe, expect, test } from "bun:test";

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import { modelRequestId } from "../providers/identity.ts";
import type { ProviderAdapterPort } from "../providers/port.ts";
import type { ModelRequest } from "../providers/request.ts";
import type { NormalizedProviderEvent } from "../providers/stream.ts";
import { createCommandCodeProviderAdapter } from "./command-code-provider-adapter.ts";

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

function child(
  name: "openai" | "anthropic",
  calls: string[],
  inputs: ModelRequest[] = [],
): ProviderAdapterPort {
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
    transportCompatibilityFor() {
      return null;
    },
    async *stream(input): AsyncIterable<NormalizedProviderEvent> {
      calls.push(name);
      inputs.push(input);
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

describe("createCommandCodeProviderAdapter", () => {
  test("routes exact model IDs through their documented provider protocol", async () => {
    const calls: string[] = [];
    const adapter = createCommandCodeProviderAdapter(
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
    const adapter = createCommandCodeProviderAdapter(
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
    const adapter = createCommandCodeProviderAdapter(
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

  test("keeps provider-managed caching out of the delegated wire protocol", async () => {
    const calls: string[] = [];
    const inputs: ModelRequest[] = [];
    const adapter = createCommandCodeProviderAdapter(
      {
        profileId: "commandcode",
        resolveApiKey: async () => "secret",
        supportedModels: ["gpt-5.6-sol"],
      },
      () => ({
        openai: child("openai", calls, inputs),
        anthropic: child("anthropic", calls, inputs),
      }),
    );

    await collect(
      adapter,
      request("gpt-5.6-sol", {
        promptCache: {
          schemaVersion: 1,
          key: `sha-256:${"a".repeat(64)}`,
          scope: "session",
          stablePrefixDigest: `sha-256:${"b".repeat(64)}`,
          stableMessageCount: 1,
          toolCatalogGeneration: 1,
          mode: "provider-managed",
          minimumInputTokens: null,
        },
      }),
    );

    expect(calls).toEqual(["openai"]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.promptCache).toBeUndefined();
  });

  test("rejects cache controls that Command Code did not publish", async () => {
    const calls: string[] = [];
    const adapter = createCommandCodeProviderAdapter(
      {
        profileId: "commandcode",
        resolveApiKey: async () => "secret",
        supportedModels: ["gpt-5.6-sol"],
      },
      () => ({
        openai: child("openai", calls),
        anthropic: child("anthropic", calls),
      }),
    );

    const events = await collect(
      adapter,
      request("gpt-5.6-sol", {
        promptCache: {
          schemaVersion: 1,
          key: `sha-256:${"c".repeat(64)}`,
          scope: "session",
          stablePrefixDigest: `sha-256:${"d".repeat(64)}`,
          stableMessageCount: 1,
          toolCatalogGeneration: 1,
          mode: "openai-routing-key",
          minimumInputTokens: 1024,
        },
      }),
    );

    expect(calls).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      failure: { kind: "unsupported-capability", retryable: false },
    });
  });
});
