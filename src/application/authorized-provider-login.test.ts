import { describe, expect, test } from "bun:test";

import {
  type CredentialReference,
  createManualClock,
  duration,
  instant,
  modelId,
  providerId,
} from "../domain/index.ts";
import {
  AUTHORIZED_LOGIN_SCHEMA_VERSION,
  type AuthorizationCallback,
  type AuthorizedProviderCredential,
  type AuthorizedProviderLoginHost,
  type ProviderAuthorizedLoginAdapter,
  type ProviderProfile,
} from "../providers/index.ts";
import { createAuthorizedLoginAdapterRegistry } from "./authorized-login-registry.ts";
import { createAuthorizedProviderLogin } from "./authorized-provider-login.ts";
import type {
  ProductAuthorizedCredentialResolution,
  ProductCredentialBundle,
} from "./product-credentials.ts";

const ACCESS_TOKEN = "fixture-access-token";
const REFRESH_TOKEN = "fixture-refresh-token";

function profile(): ProviderProfile {
  return {
    profileId: "fixture",
    providerId: providerId.from("fixture"),
    adapterKind: "openai",
    displayName: "Fixture",
    endpoint: "https://provider.example.test/v1",
    credential: null,
    organization: null,
    project: null,
    enabledModels: [modelId.from("fixture-model")],
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "static",
    timeouts: { connectMs: 1_000, requestMs: 10_000 },
  };
}

function credential(
  issuedAt = instant(100),
  expiresAt = instant(5_000),
): AuthorizedProviderCredential {
  return {
    schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
    kind: "authorized-provider",
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    tokenType: "Bearer",
    scopes: ["models.read"],
    issuedAt,
    expiresAt,
  };
}

function credentials(options: { readonly failWrite?: boolean } = {}): {
  readonly bundle: ProductCredentialBundle;
  readonly stored: Map<string, AuthorizedProviderCredential>;
} {
  const stored = new Map<string, AuthorizedProviderCredential>();
  const bundle: ProductCredentialBundle = {
    stores: [],
    resolver: {
      async resolve() {
        throw new Error("resolver is outside this coordinator fixture");
      },
    },
    async placeApiKey() {
      return { kind: "written" };
    },
    async placeAuthorizedCredential({ reference, credential: value }) {
      if (options.failWrite === true) {
        return { kind: "failed", code: "vault-denied" };
      }
      stored.set(reference.locator, value);
      return { kind: "written" };
    },
    async withAuthorizedCredential<Value>(
      reference: CredentialReference,
      use: (value: AuthorizedProviderCredential) => Value | Promise<Value>,
    ): Promise<ProductAuthorizedCredentialResolution<Value>> {
      const value = stored.get(reference.locator);
      if (value === undefined) {
        return {
          kind: "invalid",
          code: "authorized-credential-invalid",
        };
      }
      return {
        kind: "resolved",
        value: await use(value),
        health: {
          state: "present",
          storeKind: "operating-system-keychain",
          observedAt: instant(100),
        },
      };
    },
  };
  return { bundle, stored };
}

function host(callback: () => AuthorizationCallback): AuthorizedProviderLoginHost {
  return {
    crypto: {
      randomBase64Url(bytes) {
        if (bytes === 32) return "state-fixture";
        if (bytes === 48) return "verifier-fixture";
        return "attempt-fixture";
      },
      sha256Base64Url(value) {
        return `s256-${value}`;
      },
      equal(left, right) {
        return left === right;
      },
    },
    loopback: {
      async listen() {
        return {
          kind: "listening",
          session: {
            redirectUri: "http://127.0.0.1:43123/callback",
            prepareBrowserLaunch: () => "http://127.0.0.1:43123/start",
            receive: async () => callback(),
            close: async () => undefined,
          },
        };
      },
    },
    browser: { launch: async () => ({ kind: "opened" }) },
    interaction: {
      presentLocalLaunchUri: async () => ({ kind: "presented" }),
      requestAuthorizationCode: async () => ({ kind: "submitted", code: "manual-code" }),
      presentDeviceCode: async () => ({ kind: "presented" }),
    },
  };
}

function pkceAdapter(
  overrides: Partial<ProviderAuthorizedLoginAdapter> = {},
): ProviderAuthorizedLoginAdapter {
  return {
    descriptor: {
      schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
      adapterId: "fixture-authorized-login",
      providerId: providerId.from("fixture"),
      adapterKind: "openai",
      methods: ["oauth-pkce"],
      scopes: ["models.read"],
      callbackModes: ["loopback"],
      loopbackRedirectUri: null,
      manualRedirectUri: null,
      refresh: true,
      revoke: true,
      accountLookup: false,
      revision: "fixture-v1",
    },
    availability: () => ({ kind: "available" }),
    async beginPkce(_profile, input) {
      if (input.state !== "state-fixture" || input.codeChallenge !== "s256-verifier-fixture") {
        return { kind: "failed", code: "pkce-fixture-mismatch", retryable: false };
      }
      return { kind: "ready", authorizationUrl: "https://provider.example.test/authorize" };
    },
    async exchangePkce(_profile, input) {
      if (input.code !== "callback-code" || input.codeVerifier !== "verifier-fixture") {
        return { kind: "failed", code: "pkce-exchange-mismatch", retryable: false };
      }
      return {
        kind: "authorized",
        credential: credential(),
        account: {
          accountId: "account-1",
          displayName: "Fixture account",
          authMethod: "oauth-pkce",
          authorizedAt: instant(0),
          expiresAt: instant(5_000),
        },
      };
    },
    async refresh() {
      return {
        kind: "refreshed",
        credential: credential(instant(200), instant(9_000)),
        account: {
          accountId: "account-1",
          displayName: "Fixture account",
          authMethod: "oauth-pkce",
          authorizedAt: instant(0),
          expiresAt: instant(9_000),
        },
      };
    },
    revoke: async () => ({ kind: "revoked" }),
    ...overrides,
  };
}

describe("authorized provider login", () => {
  test("completes PKCE with S256, writes one secret bundle, and returns a safe receipt", async () => {
    const clock = createManualClock(instant(100));
    const vault = credentials();
    const login = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([pkceAdapter()]),
      credentials: vault.bundle,
      clock,
      host: host(() => ({ kind: "callback", state: "state-fixture", code: "callback-code" })),
    });

    const result = await login.authorize(profile(), "oauth-pkce");
    expect(result).toMatchObject({
      kind: "authorized",
      account: { accountId: "account-1", authMethod: "oauth-pkce" },
      receipt: { adapterGeneration: 1, outcome: "authorized", code: null },
    });
    expect(vault.stored.size).toBe(1);
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(result)).not.toContain("callback-code");
    expect(JSON.stringify(result)).not.toContain("verifier-fixture");
  });

  test("rejects the wrong state and never exchanges or stores the callback code", async () => {
    const clock = createManualClock(instant(100));
    const vault = credentials();
    let exchanges = 0;
    const adapter = pkceAdapter({
      async exchangePkce() {
        exchanges += 1;
        return { kind: "failed", code: "unexpected-exchange", retryable: false };
      },
    });
    const login = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([adapter]),
      credentials: vault.bundle,
      clock,
      host: host(() => ({ kind: "callback", state: "wrong-state", code: "callback-code" })),
    });

    const result = await login.authorize(profile(), "oauth-pkce");
    expect(result).toMatchObject({
      kind: "failed",
      code: "authorization-state-mismatch",
      receipt: { outcome: "failed", code: "authorization-state-mismatch" },
    });
    expect(exchanges).toBe(0);
    expect(vault.stored.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain("callback-code");
  });

  test("projects denied consent and cancellation as distinct terminal receipts", async () => {
    const clock = createManualClock(instant(100));
    const deniedVault = credentials();
    const deniedLogin = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([pkceAdapter()]),
      credentials: deniedVault.bundle,
      clock,
      host: host(() => ({ kind: "denied", state: "state-fixture", code: "access-denied" })),
    });
    expect(await deniedLogin.authorize(profile(), "oauth-pkce")).toMatchObject({
      kind: "denied",
      code: "access-denied",
      receipt: { outcome: "denied", code: "access-denied" },
    });

    const cancelledHost = host(() => ({ kind: "cancelled" }));
    cancelledHost.loopback.listen = async () => ({
      kind: "listening",
      session: {
        redirectUri: "http://127.0.0.1:43123/callback",
        prepareBrowserLaunch: () => "http://127.0.0.1:43123/start",
        receive: (signal) =>
          signal.aborted
            ? Promise.resolve({ kind: "cancelled" })
            : new Promise<AuthorizationCallback>((resolve) => {
                signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
                  once: true,
                });
              }),
        close: async () => undefined,
      },
    });
    const cancelledLogin = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([pkceAdapter()]),
      credentials: credentials().bundle,
      clock,
      host: cancelledHost,
    });
    const controller = new AbortController();
    const pending = cancelledLogin.authorize(profile(), "oauth-pkce", controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({
      kind: "cancelled",
      receipt: { outcome: "cancelled", code: "authorization-cancelled" },
    });
  });

  test("polls a device code with provider cadence and binds the starting registry generation", async () => {
    const clock = createManualClock(instant(100));
    const vault = credentials();
    const registry = createAuthorizedLoginAdapterRegistry();
    let polls = 0;
    const adapter: ProviderAuthorizedLoginAdapter = {
      descriptor: {
        schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
        adapterId: "fixture-device-code",
        providerId: providerId.from("fixture"),
        adapterKind: "openai",
        methods: ["device-code"],
        scopes: ["models.read"],
        callbackModes: [],
        loopbackRedirectUri: null,
        manualRedirectUri: null,
        refresh: false,
        revoke: false,
        accountLookup: false,
        revision: "fixture-v1",
      },
      availability: () => ({ kind: "available" }),
      async beginDeviceCode() {
        return {
          kind: "ready",
          deviceCode: "device-secret",
          userCode: "ABCD-EFGH",
          verificationUri: "https://provider.example.test/device",
          verificationUriComplete: null,
          pollIntervalMs: duration(100),
          expiresAt: instant(2_000),
        };
      },
      async pollDeviceCode() {
        polls += 1;
        if (polls === 1) return { kind: "pending", retryAfterMs: null };
        if (polls === 2) return { kind: "slow-down", retryAfterMs: duration(200) };
        return {
          kind: "authorized",
          credential: credential(clock.now(), instant(5_000)),
          account: {
            accountId: "device-account",
            displayName: null,
            authMethod: "device-code",
            authorizedAt: instant(0),
            expiresAt: instant(5_000),
          },
        };
      },
    };
    registry.replace([adapter]);
    const login = createAuthorizedProviderLogin({
      registry,
      credentials: vault.bundle,
      clock,
      host: host(() => ({ kind: "cancelled" })),
    });

    const pending = login.authorize(profile(), "device-code");
    await clock.runUntilIdle();
    const result = await pending;
    expect(result).toMatchObject({
      kind: "authorized",
      account: { accountId: "device-account" },
      receipt: { adapterGeneration: 2 },
    });
    expect(polls).toBe(3);
    expect(JSON.stringify(result)).not.toContain("device-secret");
    expect(JSON.stringify(result)).not.toContain("ABCD-EFGH");
  });

  test("stops device polling at the Falryn deadline", async () => {
    const clock = createManualClock(instant(100));
    const timedProfile = { ...profile(), timeouts: { connectMs: 100, requestMs: 300 } };
    let polls = 0;
    const adapter: ProviderAuthorizedLoginAdapter = {
      descriptor: {
        schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
        adapterId: "fixture-device-timeout",
        providerId: providerId.from("fixture"),
        adapterKind: "openai",
        methods: ["device-code"],
        scopes: [],
        callbackModes: [],
        loopbackRedirectUri: null,
        manualRedirectUri: null,
        refresh: false,
        revoke: false,
        accountLookup: false,
        revision: "fixture-v1",
      },
      availability: () => ({ kind: "available" }),
      beginDeviceCode: async () => ({
        kind: "ready",
        deviceCode: "device-secret",
        userCode: "ABCD-EFGH",
        verificationUri: "https://provider.example.test/device",
        verificationUriComplete: null,
        pollIntervalMs: duration(100),
        expiresAt: instant(5_000),
      }),
      async pollDeviceCode() {
        polls += 1;
        return { kind: "pending", retryAfterMs: null };
      },
    };
    const login = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([adapter]),
      credentials: credentials().bundle,
      clock,
      host: host(() => ({ kind: "cancelled" })),
    });
    const pending = login.authorize(timedProfile, "device-code");
    await clock.runUntilIdle();
    expect(await pending).toMatchObject({
      kind: "timed-out",
      code: "authorization-deadline-exceeded",
      receipt: { outcome: "timed-out" },
    });
    expect(polls).toBe(2);
  });

  test("rotates refresh credentials and revokes the bound remote account", async () => {
    const clock = createManualClock(instant(100));
    const vault = credentials();
    let revocations = 0;
    const adapter = pkceAdapter({
      async revoke() {
        revocations += 1;
        return { kind: "revoked" };
      },
    });
    const login = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([adapter]),
      credentials: vault.bundle,
      clock,
      host: host(() => ({ kind: "callback", state: "state-fixture", code: "callback-code" })),
    });
    const authorized = await login.authorize(profile(), "oauth-pkce");
    if (authorized.kind !== "authorized") throw new Error("fixture authorization failed");
    const connection = {
      profile: { ...profile(), credential: authorized.reference },
      account: authorized.account,
      updatedAt: clock.now(),
    };

    const refreshed = await login.refresh(connection);
    expect(refreshed).toMatchObject({ kind: "refreshed", account: { expiresAt: 9_000 } });
    if (refreshed.kind !== "refreshed") throw new Error("fixture refresh failed");
    expect(refreshed.reference.locator).not.toBe(authorized.reference.locator);
    expect(vault.stored.size).toBe(2);
    expect(await login.revoke(connection)).toEqual({ remote: "revoked", code: null });
    expect(revocations).toBe(1);
  });

  test("normalizes refresh and revocation adapter exceptions", async () => {
    const clock = createManualClock(instant(100));
    const vault = credentials();
    const adapter = pkceAdapter({
      async refresh() {
        throw new Error("provider refresh detail");
      },
      async revoke() {
        throw new Error("provider revoke detail");
      },
    });
    const login = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([adapter]),
      credentials: vault.bundle,
      clock,
      host: host(() => ({ kind: "callback", state: "state-fixture", code: "callback-code" })),
    });
    const authorized = await login.authorize(profile(), "oauth-pkce");
    if (authorized.kind !== "authorized") throw new Error("fixture authorization failed");
    const connection = {
      profile: { ...profile(), credential: authorized.reference },
      account: authorized.account,
      updatedAt: clock.now(),
    };

    expect(await login.refresh(connection)).toEqual({
      kind: "failed",
      code: "authorization-refresh-threw",
      retryable: true,
    });
    expect(await login.revoke(connection)).toEqual({
      remote: "failed",
      code: "authorization-revoke-threw",
    });
  });

  test("bounds concurrent attempts per profile and reports vault denial without secrets", async () => {
    const clock = createManualClock(instant(100));
    const vault = credentials({ failWrite: true });
    const callback = Promise.withResolvers<AuthorizationCallback>();
    const heldHost = host(() => ({ kind: "cancelled" }));
    heldHost.loopback.listen = async () => ({
      kind: "listening",
      session: {
        redirectUri: "http://127.0.0.1:43123/callback",
        prepareBrowserLaunch: () => "http://127.0.0.1:43123/start",
        receive: async () => callback.promise,
        close: async () => undefined,
      },
    });
    const login = createAuthorizedProviderLogin({
      registry: createAuthorizedLoginAdapterRegistry([pkceAdapter()]),
      credentials: vault.bundle,
      clock,
      host: heldHost,
    });

    const first = login.authorize(profile(), "oauth-pkce");
    await Promise.resolve();
    expect(await login.authorize(profile(), "oauth-pkce")).toEqual({
      kind: "failed",
      code: "authorization-already-active",
      retryable: true,
      receipt: null,
    });
    callback.resolve({ kind: "callback", state: "state-fixture", code: "callback-code" });
    const result = await first;
    expect(result).toMatchObject({
      kind: "failed",
      code: "authorized-credential-write-failed",
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });
});
