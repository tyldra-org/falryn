import { describe, expect, test } from "bun:test";
import { modelId } from "../domain/identity.ts";
import {
  ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT,
  defaultProviderTransportCompatibility,
  GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT,
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  OPENAI_RESPONSES_TRANSPORT_DEFAULT,
  PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
  resolveProviderTransportCompatibility,
} from "./transport-compatibility.ts";
import { parseProviderTransportCompatibilityDeclaration } from "./transport-compatibility-schema.ts";

describe("provider transport compatibility", () => {
  test("gives every adapter an immutable default plan", () => {
    const plans = [
      "deterministic",
      "openai",
      "anthropic",
      "google",
      "commandcode",
      "openai-codex",
      "custom",
    ].map((adapterKind) =>
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

  test("selects an exact-model override after the destination declaration", () => {
    const selectedModelId = modelId.from("compatible-model");
    const resolved = resolveProviderTransportCompatibility(
      "openai",
      { ...OPENAI_CHAT_TRANSPORT_DEFAULT, systemMessageRole: "system" },
      {
        modelId: selectedModelId,
        modelOverrides: [
          {
            schemaVersion: 1,
            modelId: selectedModelId,
            declaration: {
              ...OPENAI_CHAT_TRANSPORT_DEFAULT,
              systemMessageRole: "developer",
              maxOutputTokensField: "max_tokens",
            },
            source: {
              kind: "provider-documentation",
              url: "https://provider.example/docs/models/compatible-model",
              observedAt: "2026-08-29T00:00:00Z",
            },
          },
        ],
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.value.provenance).toBe("model-override");
    expect(resolved.value.declaration).toMatchObject({
      systemMessageRole: "developer",
      maxOutputTokensField: "max_tokens",
    });
    expect(resolved.value.receipt).toMatchObject({
      modelId: selectedModelId,
      selectedLayer: "model-override",
      source: { kind: "provider-documentation" },
      layers: [
        { layer: "adapter-default", status: "superseded" },
        { layer: "destination-profile", status: "superseded" },
        { layer: "model-override", status: "selected" },
      ],
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

  test("parses Responses retention modes and rejects contradictory state", () => {
    expect(
      parseProviderTransportCompatibilityDeclaration(OPENAI_RESPONSES_TRANSPORT_DEFAULT).ok,
    ).toBe(true);
    expect(
      parseProviderTransportCompatibilityDeclaration({
        ...OPENAI_RESPONSES_TRANSPORT_DEFAULT,
        continuation: "previous-response",
        store: false,
      }).ok,
    ).toBe(false);
    expect(
      parseProviderTransportCompatibilityDeclaration({
        ...OPENAI_RESPONSES_TRANSPORT_DEFAULT,
        store: true,
      }).ok,
    ).toBe(false);
    expect(
      parseProviderTransportCompatibilityDeclaration({
        ...OPENAI_RESPONSES_TRANSPORT_DEFAULT,
        includeEncryptedReasoning: false,
      }).ok,
    ).toBe(false);
  });

  test("parses the complete Anthropic Messages plan and rejects unsafe combinations", () => {
    const parsed = parseProviderTransportCompatibilityDeclaration(
      ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT,
    );
    expect(parsed).toEqual({ ok: true, value: ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT });

    expect(
      parseProviderTransportCompatibilityDeclaration({
        ...ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT,
        thinking: "adaptive",
        thinkingReplay: "none",
      }).ok,
    ).toBe(false);
    expect(
      parseProviderTransportCompatibilityDeclaration({
        ...ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT,
        promptCachePlacement: "system-prefix",
        promptCacheTtl: null,
      }).ok,
    ).toBe(false);
    expect(
      parseProviderTransportCompatibilityDeclaration({
        ...ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT,
        promptCachePlacement: "none",
        promptCacheTtl: "5m",
      }).ok,
    ).toBe(false);
  });

  test("parses the complete Google Generate Content plan and rejects drift", () => {
    const parsed = parseProviderTransportCompatibilityDeclaration(
      GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT,
    );
    expect(parsed).toEqual({ ok: true, value: GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT });
    expect(
      parseProviderTransportCompatibilityDeclaration({
        ...GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT,
        automaticFunctionCalling: true,
      }).ok,
    ).toBe(false);
  });
});
