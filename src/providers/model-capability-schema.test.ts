import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/identity.ts";
import { parseModelCapabilityDeclaration } from "./model-capability-schema.ts";
import { parseProviderProfile } from "./profile-schema.ts";

function declaration() {
  return {
    schemaVersion: 1 as const,
    modelId: modelId.from("model-1"),
    displayName: "Model 1",
    inputModalities: ["text", "image"] as const,
    outputModalities: ["text"] as const,
    tools: "supported" as const,
    structuredOutput: "supported" as const,
    streaming: "supported" as const,
    reasoning: "supported" as const,
    reasoningControls: ["low", "high"] as const,
    contextTokens: 128_000,
    outputTokens: 16_384,
    completeness: "complete" as const,
  };
}

describe("model capability declaration codec", () => {
  test("accepts one complete normalized declaration", () => {
    expect(parseModelCapabilityDeclaration(declaration())).toEqual({
      ok: true,
      value: declaration(),
    });
  });

  test("rejects contradictory controls and impossible limits", () => {
    const unsupportedReasoning = parseModelCapabilityDeclaration({
      ...declaration(),
      reasoning: "unsupported",
    });
    expect(unsupportedReasoning.ok).toBe(false);

    const impossibleLimit = parseModelCapabilityDeclaration({
      ...declaration(),
      contextTokens: 1_000,
      outputTokens: 2_000,
    });
    expect(impossibleLimit.ok).toBe(false);
  });

  test("represents every supported transport modality without treating code as one", () => {
    const parsed = parseModelCapabilityDeclaration({
      ...declaration(),
      inputModalities: ["text", "image", "audio", "video", "document"],
      outputModalities: ["text", "image", "audio", "video"],
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.inputModalities).not.toContain("code");
      expect(parsed.value.outputModalities).not.toContain("code");
    }
  });

  test("migrates a legacy profile by supplying an empty declaration list", () => {
    const parsed = parseProviderProfile({
      profileId: "legacy",
      providerId: providerId.from("legacy"),
      adapterKind: "openai",
      displayName: "Legacy",
      endpoint: "https://api.example.test/v1",
      credential: null,
      organization: null,
      project: null,
      enabledModels: [modelId.from("legacy-model")],
      discovery: "static",
      timeouts: { connectMs: 1_000, requestMs: 10_000 },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.modelCapabilities).toEqual([]);
    }
  });

  test("rejects declarations for models that are not enabled", () => {
    const parsed = parseProviderProfile({
      profileId: "strict",
      providerId: providerId.from("strict"),
      adapterKind: "openai",
      displayName: "Strict",
      endpoint: "https://api.example.test/v1",
      credential: null,
      organization: null,
      project: null,
      enabledModels: [modelId.from("another-model")],
      modelCapabilities: [declaration()],
      discovery: "static",
      timeouts: { connectMs: 1_000, requestMs: 10_000 },
    });

    expect(parsed.ok).toBe(false);
  });

  test("rejects credential-bearing provider endpoints at the profile codec", () => {
    for (const endpoint of [
      "https://user:secret@api.example.test/v1",
      "https://api.example.test/v1?api_key=secret",
      "https://api.example.test/v1#secret",
    ]) {
      const parsed = parseProviderProfile({
        profileId: "unsafe-endpoint",
        providerId: providerId.from("unsafe-endpoint"),
        adapterKind: "openai",
        displayName: "Unsafe endpoint",
        endpoint,
        credential: null,
        organization: null,
        project: null,
        enabledModels: [modelId.from("model-1")],
        modelCapabilities: [],
        discovery: "static",
        timeouts: { connectMs: 1_000, requestMs: 10_000 },
      });

      expect(parsed.ok).toBe(false);
    }
  });
});
