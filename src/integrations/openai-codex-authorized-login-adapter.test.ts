import { describe, expect, test } from "bun:test";
import { createAuthorizedLoginAdapterRegistry } from "../application/index.ts";
import { modelId, providerId } from "../domain/index.ts";
import {
  OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
  type ProviderProfile,
  parseAuthorizedProviderLoginDescriptor,
} from "../providers/index.ts";
import { createOpenAiCodexAuthorizedLoginAdapter } from "./openai-codex-authorized-login-adapter.ts";

function profile(): ProviderProfile {
  return {
    profileId: "openai-codex",
    providerId: providerId.from("openai-codex"),
    adapterKind: "openai-codex",
    displayName: "OpenAI Codex",
    endpoint: null,
    credential: null,
    organization: null,
    project: null,
    enabledModels: [modelId.from("gpt-5-codex")],
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

describe("OpenAI Codex authorized login policy", () => {
  test("advertises selectable methods but resolves both as provider-policy unavailable", () => {
    const adapter = createOpenAiCodexAuthorizedLoginAdapter();
    expect(parseAuthorizedProviderLoginDescriptor(adapter.descriptor).ok).toBe(true);

    const registry = createAuthorizedLoginAdapterRegistry([adapter]);
    expect(registry.methods(profile())).toEqual([]);
    for (const method of ["oauth-pkce", "device-code"] as const) {
      expect(registry.resolve(profile(), method)).toEqual({
        kind: "unavailable",
        code: OPENAI_CODEX_AUTHORIZATION_UNAVAILABLE_CODE,
      });
    }
  });
});
