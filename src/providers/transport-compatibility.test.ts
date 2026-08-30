import { describe, expect, test } from "bun:test";
import {
  defaultProviderTransportCompatibility,
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
  resolveProviderTransportCompatibility,
} from "./transport-compatibility.ts";
import { parseProviderTransportCompatibilityDeclaration } from "./transport-compatibility-schema.ts";

describe("provider transport compatibility", () => {
  test("gives every adapter an immutable default plan", () => {
    const plans = ["deterministic", "openai", "anthropic", "google", "commandcode", "custom"].map(
      (adapterKind) =>
        defaultProviderTransportCompatibility(
          adapterKind as Parameters<typeof defaultProviderTransportCompatibility>[0],
        ),
    );

    expect(plans.every((plan) => plan.provenance === "adapter-default")).toBe(true);
    expect(plans.every((plan) => /^sha-256:[0-9a-f]{64}$/u.test(plan.compatibilityId))).toBe(true);
    expect(new Set(plans.map((plan) => plan.compatibilityId)).size).toBe(plans.length);
  });

  test("resolves an explicit OpenAI-compatible declaration without mutating it", () => {
    const declaration = {
      ...OPENAI_CHAT_TRANSPORT_DEFAULT,
      systemMessageRole: "developer" as const,
      maxOutputTokensField: "max_tokens" as const,
      finishReason: "infer" as const,
    };
    const first = resolveProviderTransportCompatibility("openai", declaration);
    const second = resolveProviderTransportCompatibility("openai", { ...declaration });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.value.provenance).toBe("profile-declaration");
    expect(first.value).toEqual(second.value);
    expect(first.value.declaration).not.toEqual(
      defaultProviderTransportCompatibility("openai").declaration,
    );
  });

  test("rejects an adapter and dialect mismatch", () => {
    const resolved = resolveProviderTransportCompatibility("anthropic", {
      ...OPENAI_CHAT_TRANSPORT_DEFAULT,
    });

    expect(resolved).toEqual({
      ok: false,
      error: {
        code: "adapter-dialect-mismatch",
        adapterKind: "anthropic",
        dialect: "openai-chat-completions",
      },
    });
  });

  test("strictly parses declarations and rejects unknown fields", () => {
    const valid = parseProviderTransportCompatibilityDeclaration({
      schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
      dialect: "anthropic-messages",
    });
    const unknown = parseProviderTransportCompatibilityDeclaration({
      ...OPENAI_CHAT_TRANSPORT_DEFAULT,
      guessedFromModelName: true,
    });

    expect(valid.ok).toBe(true);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      return;
    }
    expect(unknown.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
  });
});
