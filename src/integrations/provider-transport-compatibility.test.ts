import { describe, expect, test } from "bun:test";

import {
  defaultProviderTransportCompatibility,
  OPENAI_CHAT_TRANSPORT_DEFAULT,
} from "../providers/transport-compatibility.ts";
import { resolveProviderTransportCompatibilityPlan } from "./provider-transport-compatibility.ts";

describe("resolveProviderTransportCompatibilityPlan", () => {
  test("keeps generated baseline identities in sync with their declarations", () => {
    for (const adapterKind of [
      "deterministic",
      "openai",
      "anthropic",
      "google",
      "commandcode",
      "custom",
    ] as const) {
      const expected = defaultProviderTransportCompatibility(adapterKind);
      const actual = resolveProviderTransportCompatibilityPlan(adapterKind);
      expect(actual.ok).toBe(true);
      if (actual.ok) {
        expect(actual.value).toEqual(expected);
      }
    }
  });

  test("gives different explicit declarations different content identities", () => {
    const first = resolveProviderTransportCompatibilityPlan("openai", {
      ...OPENAI_CHAT_TRANSPORT_DEFAULT,
      systemMessageRole: "developer",
    });
    const second = resolveProviderTransportCompatibilityPlan("openai", {
      ...OPENAI_CHAT_TRANSPORT_DEFAULT,
      maxOutputTokensField: "max_tokens",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.compatibilityId).not.toBe(second.value.compatibilityId);
    }
  });

  test("canonicalizes equivalent declarations before deriving identity", () => {
    const canonical = resolveProviderTransportCompatibilityPlan("openai", {
      ...OPENAI_CHAT_TRANSPORT_DEFAULT,
      systemMessageRole: "developer",
    });
    const reordered = resolveProviderTransportCompatibilityPlan("openai", {
      assistantAfterToolResult: "none",
      toolResultName: "omit",
      strictToolSchemas: false,
      finishReason: "required",
      streamingUsage: "include",
      maxOutputTokensField: "max_completion_tokens",
      systemMessageRole: "developer",
      dialect: "openai-chat-completions",
      schemaVersion: 1,
    });

    expect(canonical.ok).toBe(true);
    expect(reordered.ok).toBe(true);
    if (canonical.ok && reordered.ok) {
      expect(reordered.value).toEqual(canonical.value);
    }
  });
});
