import { describe, expect, test } from "bun:test";

import {
  type CredentialReference,
  type CredentialStorePort,
  createManualClock,
  healthForStatus,
  instant,
  modelId,
  providerId,
} from "../domain/index.ts";
import {
  type ModelDiscoveryPort,
  OPENAI_CHAT_TRANSPORT_DEFAULT,
  PROVIDER_CONNECTION_SCHEMA_VERSION,
  type ProviderConnectionState,
  type ProviderProfile,
  parseProviderConnectionState,
  unknownModelCapability,
} from "../providers/index.ts";
import { createSecretResolver } from "./credential-resolver.ts";
import type { ProductCredentialBundle } from "./product-credentials.ts";
import {
  createProviderConnectionService,
  type ProviderConnectionStorePort,
} from "./provider-connections.ts";

function profile(id: string, endpoint = "https://api.example.test/v1"): ProviderProfile {
  return {
    profileId: id,
    providerId: providerId.from(id),
    adapterKind: "openai",
    displayName: id.toUpperCase(),
    endpoint,
    credential: null,
    organization: null,
    project: null,
    enabledModels: [modelId.from(`${id}-model`)],
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

function state(...profiles: readonly ProviderProfile[]): ProviderConnectionState {
  return {
    schemaVersion: PROVIDER_CONNECTION_SCHEMA_VERSION,
    revision: 0,
    selectedProfileId: profiles[0]?.profileId ?? null,
    connections: profiles.map((item) => ({ profile: item, account: null, updatedAt: instant(0) })),
  };
}

function memoryStore(
  initial: ProviderConnectionState,
  staleWrites = 0,
): {
  readonly port: ProviderConnectionStorePort;
  state(): ProviderConnectionState;
} {
  let current = initial;
  let revision = "r0";
  let remainingStale = staleWrites;
  return {
    state: () => current,
    port: {
      async read() {
        return { state: current, fileRevision: revision };
      },
      async write(next, expected) {
        if (remainingStale > 0) {
          remainingStale -= 1;
          return { kind: "stale" };
        }
        if (expected !== revision) {
          return { kind: "stale" };
        }
        current = next;
        revision = `r${next.revision}`;
        return { kind: "written", fileRevision: revision };
      },
    },
  };
}

function mutableCredentials(clock: ReturnType<typeof createManualClock>) {
  const secrets = new Map<string, string>();
  const keychain: CredentialStorePort = {
    storeKind: "operating-system-keychain",
    availability: () => ({ kind: "available" }),
    async read(reference, use, options) {
      if (options?.signal?.aborted === true) {
        return {
          kind: "unresolved",
          failure: {
            status: "cancelled",
            code: "aborted",
            retryable: false,
            storeKind: "operating-system-keychain",
            consumer: reference.consumer,
            health: healthForStatus("cancelled", "operating-system-keychain", clock.now()),
          },
        };
      }
      const secret = secrets.get(reference.locator);
      if (secret === undefined) {
        return {
          kind: "unresolved",
          failure: {
            status: "missing",
            code: "missing",
            retryable: false,
            storeKind: "operating-system-keychain",
            consumer: reference.consumer,
            health: healthForStatus("missing", "operating-system-keychain", clock.now()),
          },
        };
      }
      return {
        kind: "resolved",
        value: await use(secret),
        health: {
          state: "present",
          storeKind: "operating-system-keychain",
          observedAt: clock.now(),
        },
      };
    },
    async removeSecret(reference) {
      return secrets.delete(reference.locator)
        ? { result: "removed", code: null }
        : { result: "not-present", code: null };
    },
  };
  return {
    bundle: {
      stores: [keychain],
      resolver: createSecretResolver({ stores: [keychain], clock }),
      async placeApiKey({ reference, secret }) {
        secrets.set(reference.locator, secret);
        return { kind: "written" };
      },
    } satisfies ProductCredentialBundle,
    place(reference: CredentialReference, secret: string) {
      secrets.set(reference.locator, secret);
    },
    has(locator: string): boolean {
      return secrets.has(locator);
    },
  };
}

describe("provider connection service", () => {
  test("owns add, login, test, selection, logout, and removal without returning secrets", async () => {
    const clock = createManualClock(instant(100));
    const stored = memoryStore(state());
    const credentials = mutableCredentials(clock);
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
    });

    expect(await service.execute({ kind: "add", profile: profile("primary") })).toMatchObject({
      kind: "completed",
      catalog: { models: [{ modelId: "primary-model" }] },
      discovery: { kind: "catalog", modelCount: 1 },
    });
    const secret = "sk-never-project-this";
    const loggedIn = await service.execute({
      kind: "login-api-key",
      profileId: "primary",
      secret,
      accountLabel: "work",
    });
    expect(loggedIn).toMatchObject({
      kind: "completed",
      catalog: { models: [{ modelId: "primary-model" }] },
      discovery: { kind: "catalog", modelCount: 1 },
    });
    expect(JSON.stringify(loggedIn)).not.toContain(secret);
    expect(JSON.stringify(stored.state())).not.toContain(secret);

    const tested = await service.execute({ kind: "test", profileId: null });
    expect(tested.kind).toBe("completed");
    if (tested.kind === "completed") {
      expect(tested.auth?.state).toBe("ready");
      expect(tested.catalog?.models.map((item) => item.modelId)).toEqual([
        modelId.from("primary-model"),
      ]);
    }
    expect((await service.openSelected()).kind).toBe("ready");

    const logout = await service.execute({ kind: "logout", profileId: "primary" });
    expect(logout.kind).toBe("completed");
    expect(credentials.has("falryn.provider.primary")).toBe(false);
    expect(stored.state().connections[0]?.profile.credential).toBeNull();
    expect(await service.execute({ kind: "remove", profileId: "primary" })).toMatchObject({
      kind: "failed",
      issue: { code: "selected-profile-remove-refused" },
    });

    await service.execute({ kind: "add", profile: profile("backup") });
    await service.execute({ kind: "use", profileId: "backup" });
    expect((await service.execute({ kind: "remove", profileId: "primary" })).kind).toBe(
      "completed",
    );
  });

  test("discovers automatically after remote login without rolling back a stored connection", async () => {
    const clock = createManualClock(instant(300));
    const stored = memoryStore(state());
    const credentials = mutableCredentials(clock);
    let discoveries = 0;
    const remoteDiscovery: ModelDiscoveryPort = {
      async discover(candidate) {
        discoveries += 1;
        if (candidate.credential === null) {
          return {
            kind: "failed",
            failure: {
              kind: "unavailable",
              code: "provider-credential-unavailable",
              retryable: false,
            },
          };
        }
        const enabled = candidate.enabledModels[0];
        if (enabled === undefined) {
          throw new Error("Missing enabled model fixture.");
        }
        return {
          kind: "catalog",
          catalog: {
            generation: 7,
            provenance: "remote-discovery",
            fetchedAt: clock.now(),
            expiresAt: null,
            models: [
              unknownModelCapability(enabled, {
                availability: "available",
                provenance: ["remote-identity"],
              }),
            ],
          },
        };
      },
    };
    const remote = { ...profile("remote"), discovery: "remote" as const };
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
      session: { remoteDiscovery },
    });

    expect(await service.execute({ kind: "add", profile: remote })).toMatchObject({
      kind: "completed",
      catalog: null,
      discovery: { kind: "failed", code: "provider-credential-unavailable" },
    });
    expect(stored.state().connections).toHaveLength(1);

    const loggedIn = await service.execute({
      kind: "login-api-key",
      profileId: "remote",
      secret: "sk-automatic-discovery",
      accountLabel: "work",
    });
    expect(loggedIn).toMatchObject({
      kind: "completed",
      auth: { state: "ready" },
      catalog: { generation: 7, models: [{ modelId: "remote-model" }] },
      discovery: { kind: "catalog", generation: 7, modelCount: 1 },
    });
    expect(discoveries).toBe(2);
    expect(JSON.stringify(loggedIn)).not.toContain("sk-automatic-discovery");
    expect(JSON.stringify(stored.state())).not.toContain("sk-automatic-discovery");
  });

  test("uses an official authorized adapter and rolls its secret back after a stale write", async () => {
    const clock = createManualClock(instant(200));
    const stored = memoryStore(state(profile("device")), 1);
    const credentials = mutableCredentials(clock);
    const reference: CredentialReference = {
      storeKind: "operating-system-keychain",
      locator: "falryn.provider.device.oauth",
      consumer: "provider:device",
      accountLabel: "device-account",
    };
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
      authorizedLogin: {
        async authorize() {
          credentials.place(reference, "authorized-secret");
          return {
            kind: "authorized",
            reference,
            account: {
              accountId: "acct-1",
              displayName: "Device account",
              authMethod: "device-code",
              authorizedAt: clock.now(),
              expiresAt: instant(500),
            },
          };
        },
      },
    });

    const result = await service.execute({
      kind: "login-authorized",
      profileId: "device",
      method: "device-code",
    });
    expect(result).toMatchObject({ kind: "failed", issue: { code: "state-stale" } });
    expect(credentials.has(reference.locator)).toBe(false);
    expect(stored.state().connections[0]?.profile.credential).toBeNull();
    expect(JSON.stringify(result)).not.toContain("authorized-secret");
  });

  test("removes an unselected profile credential and reports state divergence after deletion", async () => {
    const clock = createManualClock(instant(250));
    const reference: CredentialReference = {
      storeKind: "operating-system-keychain",
      locator: "falryn.provider.backup",
      consumer: "provider:backup",
      accountLabel: "backup",
    };
    const backup = { ...profile("backup"), credential: reference };

    const stored = memoryStore(state(profile("primary"), backup));
    const credentials = mutableCredentials(clock);
    credentials.place(reference, "remove-me");
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
    });
    const removed = await service.execute({ kind: "remove", profileId: "backup" });
    expect(removed).toMatchObject({
      kind: "completed",
      revocation: { local: "removed", remote: "not-attempted" },
    });
    expect(credentials.has(reference.locator)).toBe(false);
    expect(stored.state().connections.map((item) => item.profile.profileId)).toEqual(["primary"]);

    const sharedStored = memoryStore(
      state(profile("primary"), backup, { ...profile("mirror"), credential: reference }),
    );
    const sharedCredentials = mutableCredentials(clock);
    sharedCredentials.place(reference, "keep-shared");
    const sharedService = createProviderConnectionService({
      store: sharedStored.port,
      credentials: sharedCredentials.bundle,
      clock,
    });
    const sharedRemoval = await sharedService.execute({ kind: "remove", profileId: "backup" });
    expect(sharedRemoval).toMatchObject({
      kind: "completed",
      revocation: { local: "not-attempted", remote: "not-attempted" },
    });
    expect(sharedCredentials.has(reference.locator)).toBe(true);

    const staleStored = memoryStore(state(profile("primary"), backup), 1);
    const staleCredentials = mutableCredentials(clock);
    staleCredentials.place(reference, "remove-before-stale");
    const staleService = createProviderConnectionService({
      store: staleStored.port,
      credentials: staleCredentials.bundle,
      clock,
    });
    const diverged = await staleService.execute({ kind: "remove", profileId: "backup" });
    expect(diverged).toMatchObject({
      kind: "failed",
      issue: { code: "credential-state-diverged", retryable: true },
    });
    expect(staleCredentials.has(reference.locator)).toBe(false);
    expect(staleStored.state().connections[1]?.profile.credential).toEqual(reference);
  });

  test("keeps cancellation and endpoint policy deterministic", async () => {
    const clock = createManualClock();
    const stored = memoryStore(state(profile("cancel")));
    const credentials = mutableCredentials(clock);
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
      authorizedLogin: { authorize: async () => ({ kind: "cancelled" }) },
    });
    expect(
      await service.execute({
        kind: "login-authorized",
        profileId: "cancel",
        method: "oauth-pkce",
      }),
    ).toMatchObject({ kind: "failed", issue: { code: "cancelled" } });
    expect(stored.state().revision).toBe(0);
    expect(
      await service.execute({
        kind: "configure",
        profile: profile("cancel", "http://remote.test"),
        preserveCredential: true,
        preserveCapabilities: true,
        preserveTransportCompatibility: true,
      }),
    ).toMatchObject({ kind: "failed", issue: { code: "invalid-endpoint" } });
    for (const endpoint of [
      "https://user:secret@api.example.test/v1",
      "https://api.example.test/v1?api_key=secret",
      "https://api.example.test/v1#secret",
    ]) {
      expect(
        await service.execute({
          kind: "configure",
          profile: profile("cancel", endpoint),
          preserveCredential: true,
          preserveCapabilities: true,
          preserveTransportCompatibility: true,
        }),
      ).toMatchObject({ kind: "failed", issue: { code: "invalid-endpoint" } });
    }
  });

  test("preserves enabled model capability declarations across CLI-style configure", async () => {
    const clock = createManualClock();
    const declared: ProviderProfile = {
      ...profile("declared"),
      enabledModels: [modelId.from("declared-model")],
      modelCapabilities: [
        {
          schemaVersion: 1,
          modelId: modelId.from("declared-model"),
          displayName: "Declared model",
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "unknown",
          reasoningControls: [],
          contextTokens: 32_000,
          outputTokens: 4_000,
          completeness: "partial",
        },
      ],
    };
    const stored = memoryStore(state(declared));
    const credentials = mutableCredentials(clock);
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
    });

    expect(
      await service.execute({
        kind: "configure",
        profile: { ...declared, displayName: "Updated", modelCapabilities: [] },
        preserveCredential: true,
        preserveCapabilities: true,
        preserveTransportCompatibility: true,
      }),
    ).toMatchObject({ kind: "completed" });
    expect(stored.state().connections[0]?.profile.modelCapabilities).toEqual(
      declared.modelCapabilities,
    );
  });

  test("distinguishes compatibility preservation from an explicit baseline reset", async () => {
    const clock = createManualClock();
    const declared: ProviderProfile = {
      ...profile("compatible"),
      transportCompatibility: {
        ...OPENAI_CHAT_TRANSPORT_DEFAULT,
        systemMessageRole: "developer",
      },
    };
    const stored = memoryStore(state(declared));
    const credentials = mutableCredentials(clock);
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
    });

    expect(
      await service.execute({
        kind: "configure",
        profile: { ...declared, displayName: "Preserved", transportCompatibility: null },
        preserveCredential: true,
        preserveCapabilities: true,
        preserveTransportCompatibility: true,
      }),
    ).toMatchObject({ kind: "completed" });
    expect(stored.state().connections[0]?.profile.transportCompatibility).toEqual(
      declared.transportCompatibility,
    );

    expect(
      await service.execute({
        kind: "configure",
        profile: { ...declared, displayName: "Reset", transportCompatibility: null },
        preserveCredential: true,
        preserveCapabilities: true,
        preserveTransportCompatibility: false,
      }),
    ).toMatchObject({ kind: "completed" });
    expect(stored.state().connections[0]?.profile.transportCompatibility).toBeNull();
  });

  test("does not carry capability declarations across a provider identity change", async () => {
    const clock = createManualClock();
    const declared: ProviderProfile = {
      ...profile("declared"),
      enabledModels: [modelId.from("shared-name")],
      modelCapabilities: [
        {
          schemaVersion: 1,
          modelId: modelId.from("shared-name"),
          displayName: "OpenAI declaration",
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "unknown",
          reasoningControls: [],
          contextTokens: 32_000,
          outputTokens: 4_000,
          completeness: "partial",
        },
      ],
    };
    const stored = memoryStore(state(declared));
    const credentials = mutableCredentials(clock);
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
    });

    expect(
      await service.execute({
        kind: "configure",
        profile: {
          ...declared,
          providerId: providerId.from("anthropic"),
          adapterKind: "anthropic",
          modelCapabilities: [],
        },
        preserveCredential: true,
        preserveCapabilities: true,
        preserveTransportCompatibility: true,
      }),
    ).toMatchObject({ kind: "completed" });
    expect(stored.state().connections[0]?.profile.modelCapabilities).toEqual([]);
  });

  test("refuses an expired authorized account before catalog handoff", async () => {
    const clock = createManualClock(instant(600));
    const reference: CredentialReference = {
      storeKind: "operating-system-keychain",
      locator: "falryn.provider.expired",
      consumer: "provider:expired",
      accountLabel: "expired",
    };
    const expired = state({ ...profile("expired"), credential: reference });
    const current = expired.connections[0];
    if (current === undefined) {
      throw new Error("Missing provider fixture.");
    }
    const stored = memoryStore({
      ...expired,
      connections: [
        {
          ...current,
          account: {
            accountId: "acct-expired",
            displayName: "Expired account",
            authMethod: "device-code",
            authorizedAt: instant(100),
            expiresAt: instant(500),
          },
        },
      ],
    });
    const credentials = mutableCredentials(clock);
    credentials.place(reference, "expired-secret");
    const service = createProviderConnectionService({
      store: stored.port,
      credentials: credentials.bundle,
      clock,
    });

    expect(await service.execute({ kind: "test", profileId: "expired" })).toMatchObject({
      kind: "failed",
      issue: { code: "credential-expired", retryable: false },
      auth: { state: "invalid", code: "credential-expired" },
    });
    expect(await service.openSelected()).toMatchObject({
      kind: "unavailable",
      issue: { code: "credential-expired" },
      auth: { state: "invalid", code: "credential-expired" },
    });
  });
});

describe("provider connection state codec", () => {
  test("rejects duplicate profiles and plaintext credential material without echoing it", () => {
    const duplicate = state(profile("same"), profile("same"));
    expect(parseProviderConnectionState(duplicate).ok).toBe(false);

    const secret = "sk-plaintext-forbidden";
    const malformed = structuredClone(state(profile("demo"))) as unknown as {
      connections: { profile: { credential: unknown } }[];
    };
    if (malformed.connections[0] !== undefined) {
      malformed.connections[0].profile.credential = secret;
    }
    const parsed = parseProviderConnectionState(malformed);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });
});
