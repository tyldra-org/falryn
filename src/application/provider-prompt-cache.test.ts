import { describe, expect, test } from "bun:test";

import { configurationGeneration, modelId, providerId, sessionId } from "../domain/index.ts";
import type { RoutingReceipt } from "../providers/index.ts";
import { providerPromptCachePolicy } from "./provider-prompt-cache.ts";

const generation = configurationGeneration.from(7);

function receipt(overrides: Partial<RoutingReceipt> = {}): RoutingReceipt {
  return {
    role: "default",
    intent: "coding",
    selectionReason: "intent-mapped-role",
    requiredCapabilities: { tools: true, streaming: true },
    providerId: providerId.from("openai"),
    providerProfileId: "primary",
    providerAdapterKind: "openai",
    providerDestinationId: "sha-256:destination",
    modelId: modelId.from("gpt-5.6-sol"),
    reasoning: "provider-default",
    reasoningControl: null,
    fallbackPosition: 0,
    budgets: {},
    catalogGeneration: 4,
    modelCapabilitySchemaVersion: 1,
    catalogProvenance: "static-config",
    recordedAt: null,
    ...overrides,
    responseDensityControls: overrides.responseDensityControls ?? [],
    promptCacheMode:
      "promptCacheMode" in overrides ? overrides.promptCacheMode : "openai-routing-key",
    promptCacheMinimumInputTokens:
      "promptCacheMinimumInputTokens" in overrides ? overrides.promptCacheMinimumInputTokens : 1024,
  };
}

function policy(overrides: Partial<Parameters<typeof providerPromptCachePolicy>[0]> = {}) {
  return providerPromptCachePolicy({
    sessionId: sessionId.from("session-1"),
    configurationGeneration: generation,
    receipt: receipt(),
    seed: {
      stablePrefixDigest: `sha-256:${"a".repeat(64)}`,
      stableMessageCount: 2,
      toolCatalogGeneration: 7,
    },
    ...overrides,
  });
}

describe("providerPromptCachePolicy", () => {
  test("reuses one secret-safe key for the same bound session and route", () => {
    const first = policy();
    const second = policy();
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mode: "openai-routing-key",
      minimumInputTokens: 1024,
    });
    expect(first.key).toMatch(/^sha-256:[a-f0-9]{64}$/u);
    expect(first.key).not.toContain("session-1");
  });

  test("breaks identity when the session, route, generation, or prefix changes", () => {
    const baseline = policy().key;
    const variants = [
      policy({ sessionId: sessionId.from("session-2") }).key,
      policy({ receipt: receipt({ modelId: modelId.from("gpt-5.6-terra") }) }).key,
      policy({ configurationGeneration: configurationGeneration.from(8) }).key,
      policy({
        seed: {
          stablePrefixDigest: `sha-256:${"a".repeat(64)}`,
          stableMessageCount: 2,
          toolCatalogGeneration: 8,
        },
      }).key,
      policy({
        seed: {
          stablePrefixDigest: `sha-256:${"b".repeat(64)}`,
          stableMessageCount: 2,
          toolCatalogGeneration: 7,
        },
      }).key,
    ];
    expect(new Set([baseline, ...variants]).size).toBe(variants.length + 1);
  });

  test("does not invent a cache mechanism for a route that did not declare one", () => {
    expect(() =>
      providerPromptCachePolicy({
        sessionId: sessionId.from("session-1"),
        configurationGeneration: generation,
        receipt: receipt({ promptCacheMode: null }),
        seed: {
          stablePrefixDigest: `sha-256:${"a".repeat(64)}`,
          stableMessageCount: 2,
          toolCatalogGeneration: 7,
        },
      }),
    ).toThrow("requires a routed cache mechanism");
  });
});
