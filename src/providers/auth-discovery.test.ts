import { describe, expect, test } from "bun:test";

import { createSecretResolver } from "../application/credential-resolver.ts";
import {
  type CredentialReference,
  createInMemoryCredentialStore,
  createManualClock,
  modelId,
  providerId,
} from "../domain/index.ts";
import { establishProviderAuth, removeProviderCredential } from "./auth-service.ts";
import {
  createDeterministicRemoteDiscovery,
  createStaticModelDiscovery,
  discoverModelCatalog,
} from "./discovery.ts";
import type { ProviderProfile } from "./profile.ts";
import { parseProviderProfile } from "./profile-schema.ts";
import { openProviderSession } from "./session.ts";

const REFERENCE: CredentialReference = {
  storeKind: "environment",
  locator: "FALRYN_TEST_PROVIDER_KEY",
  consumer: "provider:demo",
  accountLabel: "test",
};

function demoProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    profileId: "demo",
    providerId: providerId.from("demo-provider"),
    adapterKind: "deterministic",
    displayName: "Demo",
    endpoint: null,
    credential: REFERENCE,
    organization: null,
    project: null,
    enabledModels: [modelId.from("demo-fast"), modelId.from("demo-deep")],
    discovery: "static",
    timeouts: { connectMs: 5_000, requestMs: 30_000 },
    ...overrides,
    transportCompatibility: overrides.transportCompatibility ?? null,
    modelCapabilities: overrides.modelCapabilities ?? [],
  };
}

describe("parseProviderProfile", () => {
  test("accepts a complete profile", () => {
    const parsed = parseProviderProfile(demoProfile());
    expect(parsed.ok).toBe(true);
  });

  test("defaults the transport plan and rejects a mismatched dialect", () => {
    const defaulted = parseProviderProfile({
      ...demoProfile(),
      transportCompatibility: undefined,
    });
    const mismatched = parseProviderProfile({
      ...demoProfile({ adapterKind: "anthropic" }),
      transportCompatibility: {
        schemaVersion: 1,
        dialect: "openai-chat-completions",
        systemMessageRole: "system",
        maxOutputTokensField: "max_completion_tokens",
        streamingUsage: "include",
        finishReason: "required",
        strictToolSchemas: false,
        toolResultName: "omit",
        assistantAfterToolResult: "none",
      },
    });

    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.value.transportCompatibility).toBeNull();
      expect(defaulted.value.modelTransportCompatibility).toEqual([]);
    }
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.error.issues.some((issue) => issue.path.endsWith("dialect"))).toBe(true);
    }
  });

  test("accepts sourced exact-model compatibility and rejects disabled models", () => {
    const exact = {
      schemaVersion: 1 as const,
      modelId: modelId.from("demo-fast"),
      declaration: { schemaVersion: 1 as const, dialect: "deterministic" as const },
      source: {
        kind: "provider-documentation" as const,
        url: "https://provider.example/models/demo-fast",
        observedAt: "2026-08-29T00:00:00Z",
      },
    };
    const accepted = parseProviderProfile(demoProfile({ modelTransportCompatibility: [exact] }));
    const disabled = parseProviderProfile({
      ...demoProfile(),
      modelTransportCompatibility: [{ ...exact, modelId: modelId.from("disabled-model") }],
    });

    expect(accepted.ok).toBe(true);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.error.issues.some((issue) => issue.path.endsWith("modelId"))).toBe(true);
    }
  });

  test("rejects a plaintext credential without echoing it", () => {
    const parsed = parseProviderProfile({
      ...demoProfile(),
      credential: "sk-live-super-secret-value",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(JSON.stringify(parsed.error)).not.toContain("sk-live");
      expect(parsed.error.issues.some((issue) => issue.code === "plaintext-credential")).toBe(true);
    }
  });
});

describe("establishProviderAuth", () => {
  test("reports unconfigured when no credential is set", async () => {
    const clock = createManualClock();
    const resolver = createSecretResolver({
      stores: [createInMemoryCredentialStore({ storeKind: "environment" })],
      clock,
    });
    const outcome = await establishProviderAuth({
      profile: demoProfile({ credential: null }),
      resolver,
      clock,
    });
    expect(outcome.kind).toBe("not-ready");
    expect(outcome.snapshot.state).toBe("unconfigured");
    expect(JSON.stringify(outcome.snapshot)).not.toMatch(/sk-|secret/i);
  });

  test("becomes ready when the store resolves a non-empty secret", async () => {
    const clock = createManualClock();
    const store = createInMemoryCredentialStore({
      storeKind: "environment",
      secrets: { [REFERENCE.locator]: "tok-not-logged" },
    });
    const resolver = createSecretResolver({ stores: [store], clock });
    const outcome = await establishProviderAuth({
      profile: demoProfile(),
      resolver,
      clock,
    });
    expect(outcome.kind).toBe("ready");
    if (outcome.kind === "ready") {
      expect(outcome.snapshot.state).toBe("ready");
      expect(JSON.stringify(outcome.snapshot)).not.toContain("tok-not-logged");
    }
  });

  test("maps a missing secret to unconfigured", async () => {
    const clock = createManualClock();
    const resolver = createSecretResolver({
      stores: [createInMemoryCredentialStore({ storeKind: "environment" })],
      clock,
    });
    const outcome = await establishProviderAuth({
      profile: demoProfile(),
      resolver,
      clock,
    });
    expect(outcome.kind).toBe("not-ready");
    expect(outcome.snapshot.state).toBe("unconfigured");
  });
});

describe("discovery", () => {
  test("static discovery lists enabled models with provenance", async () => {
    const clock = createManualClock();
    const outcome = await discoverModelCatalog(
      demoProfile(),
      { staticDiscovery: createStaticModelDiscovery({ generation: 2 }) },
      { signal: new AbortController().signal, now: clock.now() },
    );
    expect(outcome.kind).toBe("catalog");
    if (outcome.kind === "catalog") {
      expect(outcome.catalog.provenance).toBe("static-config");
      expect(outcome.catalog.generation).toBe(2);
      expect(outcome.catalog.models.map((model) => model.modelId)).toEqual([
        modelId.from("demo-fast"),
        modelId.from("demo-deep"),
      ]);
    }
  });

  test("built-in OpenAI profiles receive only source-verified compatibility facts", async () => {
    const clock = createManualClock();
    const legacy = demoProfile({
      providerId: providerId.from("openai"),
      adapterKind: "openai",
      endpoint: "https://api.openai.com/v1",
      credential: null,
      enabledModels: [
        modelId.from("gpt-5.6-sol"),
        modelId.from("gpt-4o-mini"),
        modelId.from("unknown-openai-model"),
      ],
    });
    const outcome = await createStaticModelDiscovery().discover(legacy, {
      signal: new AbortController().signal,
      now: clock.now(),
    });

    expect(outcome.kind).toBe("catalog");
    if (outcome.kind !== "catalog") {
      return;
    }
    expect(outcome.catalog.models[0]).toMatchObject({
      modelId: modelId.from("gpt-5.6-sol"),
      inputModalities: ["text", "image"],
      tools: "supported",
      reasoning: "supported",
      reasoningControls: ["none", "low", "medium", "high", "xhigh", "max"],
      contextTokens: 1_050_000,
      outputTokens: 128_000,
      provenance: ["falryn-builtin"],
    });
    expect(outcome.catalog.models[1]).toMatchObject({
      modelId: modelId.from("gpt-4o-mini"),
      inputModalities: ["text", "image"],
      tools: "supported",
      provenance: ["falryn-builtin"],
    });
    expect(outcome.catalog.models[2]).toMatchObject({
      modelId: modelId.from("unknown-openai-model"),
      tools: "unknown",
      provenance: ["compatibility-default"],
    });

    const customEndpoint = await createStaticModelDiscovery().discover(
      { ...legacy, endpoint: "https://provider.example.test/v1" },
      { signal: new AbortController().signal, now: clock.now() },
    );
    expect(customEndpoint).toMatchObject({
      kind: "catalog",
      catalog: {
        models: [
          { modelId: modelId.from("gpt-5.6-sol"), tools: "unknown" },
          { modelId: modelId.from("gpt-4o-mini"), tools: "unknown" },
          { modelId: modelId.from("unknown-openai-model"), tools: "unknown" },
        ],
      },
    });
  });

  test("remote discovery uses the injectable port without network", async () => {
    const clock = createManualClock();
    const remote = createDeterministicRemoteDiscovery({
      catalog: {
        generation: 9,
        provenance: "remote-discovery",
        fetchedAt: clock.now(),
        expiresAt: null,
        models: [
          {
            schemaVersion: 1,
            modelId: modelId.from("remote-1"),
            displayName: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            tools: "supported",
            structuredOutput: "supported",
            streaming: "supported",
            reasoning: "supported",
            reasoningControls: ["balanced"],
            completeness: "complete",
            availability: "available",
            provenance: ["profile-declaration"],
            contextTokens: 1000,
            outputTokens: 100,
          },
        ],
      },
    });
    const outcome = await discoverModelCatalog(
      demoProfile({ discovery: "remote" }),
      { staticDiscovery: createStaticModelDiscovery(), remoteDiscovery: remote },
      { signal: new AbortController().signal, now: clock.now() },
    );
    expect(outcome.kind).toBe("catalog");
    if (outcome.kind === "catalog") {
      expect(outcome.catalog.provenance).toBe("remote-discovery");
      expect(outcome.catalog.generation).toBe(9);
    }
  });

  test("remote unknown facts preserve explicit declarations and exclude unconfigured models", async () => {
    const clock = createManualClock();
    const configuredModel = modelId.from("demo-fast");
    const configured = demoProfile({
      discovery: "remote",
      enabledModels: [configuredModel],
      modelCapabilities: [
        {
          schemaVersion: 1,
          modelId: configuredModel,
          displayName: "Configured",
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "unsupported",
          reasoningControls: [],
          responseDensityControls: ["low"],
          contextTokens: 128_000,
          outputTokens: 16_384,
          completeness: "complete",
        },
      ],
    });
    const remote = createDeterministicRemoteDiscovery({
      catalog: {
        generation: 12,
        provenance: "remote-discovery",
        fetchedAt: clock.now(),
        expiresAt: null,
        models: [
          {
            schemaVersion: 1,
            modelId: configuredModel,
            displayName: "Remote identity",
            inputModalities: [],
            outputModalities: [],
            tools: "unknown",
            structuredOutput: "unknown",
            streaming: "unknown",
            reasoning: "unknown",
            reasoningControls: [],
            responseDensityControls: ["medium", "high"],
            contextTokens: null,
            outputTokens: null,
            completeness: "partial",
            availability: "available",
            provenance: ["remote-identity"],
          },
          {
            schemaVersion: 1,
            modelId: modelId.from("not-configured"),
            displayName: "Not configured",
            inputModalities: ["text"],
            outputModalities: ["text"],
            tools: "supported",
            structuredOutput: "supported",
            streaming: "supported",
            reasoning: "unsupported",
            reasoningControls: [],
            contextTokens: 8_000,
            outputTokens: 1_000,
            completeness: "complete",
            availability: "available",
            provenance: ["provider-manifest"],
          },
        ],
      },
    });

    const outcome = await discoverModelCatalog(
      configured,
      { staticDiscovery: createStaticModelDiscovery(), remoteDiscovery: remote },
      { signal: new AbortController().signal, now: clock.now() },
    );
    expect(outcome.kind).toBe("catalog");
    if (outcome.kind === "catalog") {
      expect(outcome.catalog.models).toHaveLength(1);
      expect(outcome.catalog.models[0]).toMatchObject({
        modelId: configuredModel,
        inputModalities: ["text", "image"],
        tools: "supported",
        responseDensityControls: ["low"],
        contextTokens: 128_000,
        availability: "available",
        provenance: ["profile-declaration", "remote-identity"],
      });
    }
  });
});

describe("openProviderSession", () => {
  test("opens a ready session with catalog when auth succeeds", async () => {
    const clock = createManualClock();
    const store = createInMemoryCredentialStore({
      storeKind: "environment",
      secrets: { [REFERENCE.locator]: "tok-session" },
    });
    const result = await openProviderSession({
      profile: demoProfile(),
      ports: {
        resolver: createSecretResolver({ stores: [store], clock }),
        clock,
      },
    });
    expect(result.kind).toBe("opened");
    if (result.kind === "opened") {
      expect(result.session.auth.state).toBe("ready");
      expect(result.session.catalog?.models).toHaveLength(2);
      expect(JSON.stringify(result.session)).not.toContain("tok-session");
    }
  });

  test("returns auth-not-ready with discovery still attached", async () => {
    const clock = createManualClock();
    const result = await openProviderSession({
      profile: demoProfile({ credential: null }),
      ports: {
        resolver: createSecretResolver({
          stores: [createInMemoryCredentialStore({ storeKind: "environment" })],
          clock,
        }),
        clock,
      },
    });
    expect(result.kind).toBe("auth-not-ready");
    if (result.kind === "auth-not-ready") {
      expect(result.session.discovery.kind).toBe("catalog");
    }
  });
});

describe("removeProviderCredential", () => {
  test("reports local removal separately from remote revocation", async () => {
    const store = createInMemoryCredentialStore({
      storeKind: "environment",
      secrets: { [REFERENCE.locator]: "tok-remove" },
    });
    const report = await removeProviderCredential({
      profile: demoProfile(),
      stores: [store],
    });
    expect(report.local).toBe("removed");
    expect(report.remote).toBe("not-attempted");
  });
});
