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
  };
}

describe("parseProviderProfile", () => {
  test("accepts a complete profile", () => {
    const parsed = parseProviderProfile(demoProfile());
    expect(parsed.ok).toBe(true);
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
            modelId: modelId.from("remote-1"),
            modalities: ["text"],
            tools: true,
            streaming: true,
            reasoning: true,
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
