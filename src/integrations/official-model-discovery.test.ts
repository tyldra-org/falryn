import { describe, expect, test } from "bun:test";

import type { ModelInfo as AnthropicModelInfo } from "@anthropic-ai/sdk/resources/models";

import { instant } from "../domain/clock.ts";
import { modelId, providerId } from "../domain/identity.ts";
import type { ProviderProfile } from "../providers/profile.ts";
import {
  createOfficialModelDiscovery,
  officialModelCapabilityTranslators,
} from "./official-model-discovery.ts";

function profile(
  adapterKind: ProviderProfile["adapterKind"],
  models: readonly string[],
): ProviderProfile {
  return {
    profileId: adapterKind,
    providerId: providerId.from(adapterKind),
    adapterKind,
    displayName: adapterKind,
    endpoint: null,
    credential: null,
    organization: null,
    project: null,
    enabledModels: models.map(modelId.from),
    modelCapabilities: [],
    discovery: "remote",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

function anthropicModel(): AnthropicModelInfo {
  const yes = { supported: true };
  const no = { supported: false };
  return {
    id: "claude-example",
    display_name: "Claude Example",
    created_at: "2026-01-01T00:00:00Z",
    type: "model",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    capabilities: {
      batch: yes,
      citations: yes,
      code_execution: yes,
      image_input: yes,
      pdf_input: yes,
      structured_outputs: yes,
      context_management: {
        supported: true,
        clear_thinking_20251015: yes,
        clear_tool_uses_20250919: yes,
        compact_20260112: yes,
      },
      effort: {
        supported: true,
        low: yes,
        medium: yes,
        high: yes,
        max: no,
        xhigh: null,
      },
      thinking: {
        supported: true,
        types: { adaptive: yes, enabled: yes },
      },
    },
  };
}

describe("official model capability translation", () => {
  test("does not infer OpenAI capabilities from a model name", () => {
    const capability = officialModelCapabilityTranslators.openai({
      id: "gpt-future",
      object: "model",
      created: 0,
      owned_by: "openai",
    });

    expect(capability).toMatchObject({
      modelId: modelId.from("gpt-future"),
      tools: "unknown",
      structuredOutput: "unknown",
      reasoning: "unknown",
      completeness: "partial",
      availability: "available",
      provenance: ["remote-identity"],
    });
  });

  test("maps the capability object returned by the Anthropic SDK", () => {
    const capability = officialModelCapabilityTranslators.anthropic(anthropicModel());

    expect(capability).toMatchObject({
      inputModalities: ["text", "image", "document"],
      outputModalities: ["text"],
      tools: "unknown",
      structuredOutput: "supported",
      streaming: "supported",
      reasoning: "supported",
      reasoningControls: ["low", "medium", "high"],
      contextTokens: 200_000,
      outputTokens: 64_000,
      provenance: ["provider-manifest"],
    });
  });

  test("maps Gemini limits, actions, and thinking without guessing modalities", () => {
    const capability = officialModelCapabilityTranslators.google({
      name: "models/gemini-example",
      displayName: "Gemini Example",
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 65_536,
      supportedActions: ["generateContent", "countTokens"],
      thinking: true,
    });

    expect(capability).toMatchObject({
      modelId: modelId.from("gemini-example"),
      inputModalities: ["text"],
      outputModalities: ["text"],
      tools: "unknown",
      structuredOutput: "unknown",
      reasoning: "supported",
      reasoningControls: ["provider-default"],
      contextTokens: 1_000_000,
      outputTokens: 65_536,
    });
  });

  test("maps Command Code identity, display name, and context without guessing features", () => {
    const capability = officialModelCapabilityTranslators.commandcode({
      id: "gpt-5.6-sol",
      object: "model",
      created: 0,
      owned_by: "commandcode",
      name: "GPT-5.6 Sol",
      context_length: 1_050_000,
    });

    expect(capability).toMatchObject({
      modelId: modelId.from("gpt-5.6-sol"),
      displayName: "GPT-5.6 Sol",
      tools: "unknown",
      streaming: "unknown",
      contextTokens: 1_050_000,
      availability: "available",
      provenance: ["remote-identity"],
    });
  });
});

describe("createOfficialModelDiscovery", () => {
  test("publishes only configured model identities and marks missing ones unavailable", async () => {
    const discovery = createOfficialModelDiscovery({
      generation: 11,
      ttlMs: 60_000,
      resolveApiKey: async () => "secret-never-returned",
      loaders: {
        openai: async () => [
          { id: "enabled", object: "model", created: 0, owned_by: "openai" },
          { id: "not-enabled", object: "model", created: 0, owned_by: "openai" },
        ],
      },
    });
    const outcome = await discovery.discover(profile("openai", ["enabled", "missing"]), {
      signal: new AbortController().signal,
      now: instant(1_000),
    });

    expect(outcome.kind).toBe("catalog");
    if (outcome.kind !== "catalog") {
      return;
    }
    expect(outcome.catalog.generation).toBe(11);
    expect(outcome.catalog.expiresAt).toBe(instant(61_000));
    expect(outcome.catalog.models.map((model) => String(model.modelId))).toEqual([
      "enabled",
      "missing",
    ]);
    expect(outcome.catalog.models.map((model) => model.availability)).toEqual([
      "available",
      "unavailable",
    ]);
    expect(JSON.stringify(outcome)).not.toContain("secret-never-returned");
  });

  test("publishes a new immutable generation on each successful refresh", async () => {
    const discovery = createOfficialModelDiscovery({
      generation: 20,
      resolveApiKey: async () => "secret",
      loaders: {
        openai: async () => [{ id: "enabled", object: "model", created: 0, owned_by: "openai" }],
      },
    });
    const input = profile("openai", ["enabled"]);
    const first = await discovery.discover(input, {
      signal: new AbortController().signal,
      now: instant(1),
    });
    const second = await discovery.discover(input, {
      signal: new AbortController().signal,
      now: instant(2),
    });

    expect(first).toMatchObject({ kind: "catalog", catalog: { generation: 20 } });
    expect(second).toMatchObject({ kind: "catalog", catalog: { generation: 21 } });
  });

  test("discovers Command Code through its models endpoint and selects enabled models", async () => {
    const discovery = createOfficialModelDiscovery({
      generation: 30,
      resolveApiKey: async () => "command-code-key",
      loaders: {
        commandcode: async () => [
          {
            id: "gpt-5.6-sol",
            object: "model",
            created: 0,
            owned_by: "commandcode",
            name: "GPT-5.6 Sol",
            context_length: 1_050_000,
          },
          {
            id: "claude-sonnet-5",
            object: "model",
            created: 0,
            owned_by: "commandcode",
            name: "Claude Sonnet 5",
            context_length: 1_000_000,
          },
        ],
      },
    });
    const outcome = await discovery.discover(profile("commandcode", ["claude-sonnet-5"]), {
      signal: new AbortController().signal,
      now: instant(5),
    });

    expect(outcome).toMatchObject({
      kind: "catalog",
      catalog: {
        generation: 30,
        models: [
          {
            modelId: "claude-sonnet-5",
            displayName: "Claude Sonnet 5",
            contextTokens: 1_000_000,
            availability: "available",
          },
        ],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("command-code-key");
  });

  test("passes a custom endpoint to the selected official SDK loader", async () => {
    let observedEndpoint: string | null = null;
    const discovery = createOfficialModelDiscovery({
      resolveApiKey: async () => "secret",
      loaders: {
        openai: async (input) => {
          observedEndpoint = input.endpoint;
          return [{ id: "enabled", object: "model", created: 0, owned_by: "owner" }];
        },
      },
    });
    const input = {
      ...profile("openai", ["enabled"]),
      endpoint: "https://provider.example.test/v1",
    };

    await discovery.discover(input, {
      signal: new AbortController().signal,
      now: instant(0),
    });
    expect(observedEndpoint as string | null).toBe("https://provider.example.test/v1");
  });

  test("rejects malformed provider records instead of publishing an invalid catalog", async () => {
    const discovery = createOfficialModelDiscovery({
      resolveApiKey: async () => "secret",
      loaders: {
        openai: async () =>
          [{ id: "contains whitespace", object: "model", created: 0, owned_by: "openai" }] as never,
      },
    });
    const outcome = await discovery.discover(profile("openai", ["enabled"]), {
      signal: new AbortController().signal,
      now: instant(0),
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { kind: "malformed", code: "provider-model-record-malformed", retryable: false },
    });
  });

  test("rejects duplicate remote model identities instead of collapsing them", async () => {
    const duplicate = { id: "enabled", object: "model", created: 0, owned_by: "openai" } as const;
    const discovery = createOfficialModelDiscovery({
      resolveApiKey: async () => "secret",
      loaders: { openai: async () => [duplicate, duplicate] },
    });
    const outcome = await discovery.discover(profile("openai", ["enabled"]), {
      signal: new AbortController().signal,
      now: instant(0),
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { kind: "malformed", code: "provider-model-record-duplicate", retryable: false },
    });
  });

  test("rejects a Google record without a model identity", async () => {
    const discovery = createOfficialModelDiscovery({
      resolveApiKey: async () => "secret",
      loaders: { google: async () => [{} as never] },
    });
    const outcome = await discovery.discover(profile("google", ["gemini-example"]), {
      signal: new AbortController().signal,
      now: instant(0),
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { kind: "malformed", code: "provider-model-record-malformed", retryable: false },
    });
  });

  test("classifies cancellation, timeout, authentication, and rate limits without messages", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cancelledDiscovery = createOfficialModelDiscovery({
      resolveApiKey: async () => "secret",
    });
    expect(
      await cancelledDiscovery.discover(profile("openai", ["enabled"]), {
        signal: aborted.signal,
        now: instant(0),
      }),
    ).toMatchObject({ kind: "failed", failure: { kind: "cancelled", retryable: false } });

    for (const fixture of [
      {
        error: Object.assign(new Error("secret timeout detail"), { name: "TimeoutError" }),
        expected: { kind: "timed-out", retryable: true },
      },
      {
        error: Object.assign(new Error("secret auth detail"), { status: 401 }),
        expected: { kind: "authentication", retryable: false },
      },
      {
        error: Object.assign(new Error("secret rate detail"), { status: 429 }),
        expected: { kind: "rate-limited", retryable: true },
      },
    ] as const) {
      const discovery = createOfficialModelDiscovery({
        resolveApiKey: async () => "secret",
        loaders: { openai: async () => Promise.reject(fixture.error) },
      });
      const outcome = await discovery.discover(profile("openai", ["enabled"]), {
        signal: new AbortController().signal,
        now: instant(0),
      });
      expect(outcome).toMatchObject({ kind: "failed", failure: fixture.expected });
      expect(JSON.stringify(outcome)).not.toContain("secret");
    }
  });

  test("fails closed when credentials are unavailable", async () => {
    let loaded = false;
    const discovery = createOfficialModelDiscovery({
      resolveApiKey: async () => null,
      loaders: {
        google: async () => {
          loaded = true;
          return [];
        },
      },
    });
    const outcome = await discovery.discover(profile("google", ["gemini-example"]), {
      signal: new AbortController().signal,
      now: instant(0),
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { code: "provider-credential-unavailable", retryable: false },
    });
    expect(loaded).toBe(false);
  });

  test("normalizes credential resolver failures without leaking their message", async () => {
    const discovery = createOfficialModelDiscovery({
      resolveApiKey: async () => {
        throw new Error("credential backend included secret-value");
      },
    });
    const outcome = await discovery.discover(profile("openai", ["model"]), {
      signal: new AbortController().signal,
      now: instant(0),
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      failure: { code: "provider-discovery-unavailable", retryable: true },
    });
    expect(JSON.stringify(outcome)).not.toContain("secret-value");
  });
});
