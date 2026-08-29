import { describe, expect, test } from "bun:test";

import {
  type CredentialReference,
  createManualClock,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  type LocalDataPlatform,
} from "../domain/index.ts";
import {
  createKeychainCredentialStore,
  type OperatingSystemSecretsPort,
} from "./keychain-credentials.ts";

type SecretCall =
  | { readonly kind: "get" | "delete"; readonly service: string; readonly name: string }
  | {
      readonly kind: "set";
      readonly service: string;
      readonly name: string;
      readonly value: string;
    };

function secrets(
  options: {
    readonly value?: string | null;
    readonly deleted?: boolean;
    readonly fail?: boolean;
  } = {},
): OperatingSystemSecretsPort & { calls(): readonly SecretCall[] } {
  const calls: SecretCall[] = [];
  return {
    calls: () => [...calls],
    async get(input) {
      calls.push({ kind: "get", ...input });
      if (options.fail === true) throw new Error("host failure whose text must not escape");
      return options.value ?? null;
    },
    async set(input) {
      calls.push({ kind: "set", service: input.service, name: input.name, value: input.value });
      if (options.fail === true) throw new Error("host failure whose text must not escape");
    },
    async delete(input) {
      calls.push({ kind: "delete", ...input });
      if (options.fail === true) throw new Error("host failure whose text must not escape");
      return options.deleted ?? false;
    },
  };
}

function reference(overrides: Partial<CredentialReference> = {}): CredentialReference {
  return {
    storeKind: "operating-system-keychain",
    locator: "falryn.provider.example",
    consumer: "provider:example",
    accountLabel: "work@example.com",
    ...overrides,
  };
}

function store(secretPort: OperatingSystemSecretsPort, platform: LocalDataPlatform = "darwin") {
  return createKeychainCredentialStore({
    clock: createManualClock(),
    platform,
    secrets: secretPort,
  });
}

describe("operating-system credential store", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    test(`is available through Bun.secrets on ${platform}`, () => {
      expect(store(secrets(), platform).availability()).toEqual({ kind: "available" });
    });
  }

  test("reads only the exact service and account and never returns the secret", async () => {
    const secretPort = secrets({ value: "sk-live-value" });
    const resolution = await store(secretPort).read(reference(), (secret) => secret.length);

    expect(secretPort.calls()).toEqual([
      {
        kind: "get",
        service: "falryn.provider.example",
        name: "work@example.com",
      },
    ]);
    expect(resolution.kind === "resolved" && resolution.value).toBe("sk-live-value".length);
    expect(JSON.stringify(resolution)).not.toContain("sk-live-value");
  });

  test("uses the bound consumer identity when no account label exists", async () => {
    const secretPort = secrets({ value: "value" });
    await store(secretPort).read(reference({ accountLabel: null }), (secret) => secret);
    expect(secretPort.calls()[0]).toMatchObject({ name: "provider:example" });
  });

  test("distinguishes missing, empty, malformed, and unavailable values", async () => {
    const missing = await store(secrets({ value: null })).read(reference(), (secret) => secret);
    expect(missing.kind === "unresolved" && missing.failure.status).toBe("missing");

    const empty = await store(secrets({ value: "" })).read(reference(), (secret) => secret);
    expect(empty.kind === "unresolved" && empty.failure.status).toBe("empty");

    const malformed = await store(secrets()).read(
      reference({ locator: `bad${String.fromCharCode(1)}` }),
      (secret) => secret,
    );
    expect(malformed.kind === "unresolved" && malformed.failure.status).toBe("malformed");

    const failed = await store(secrets({ fail: true })).read(reference(), (secret) => secret);
    expect(failed.kind === "unresolved" && failed.failure).toMatchObject({
      status: "unavailable",
      code: "secrets-failed",
      retryable: true,
    });
  });

  test("an already-aborted read never reaches the operating-system store", async () => {
    const controller = new AbortController();
    controller.abort();
    const secretPort = secrets({ value: "value" });
    const resolution = await store(secretPort).read(reference(), (secret) => secret, {
      signal: controller.signal,
    });
    expect(secretPort.calls()).toEqual([]);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("cancelled");
  });

  test("a pending host read is bounded by the credential deadline", async () => {
    const clock = createManualClock();
    const secretPort: OperatingSystemSecretsPort = {
      get: () => new Promise<string | null>(() => undefined),
      set: async () => undefined,
      delete: async () => false,
    };
    const credentialStore = createKeychainCredentialStore({
      clock,
      platform: "darwin",
      secrets: secretPort,
    });
    const pending = credentialStore.read(reference(), (secret) => secret);
    await clock.advance(DEFAULT_CREDENTIAL_TIMEOUT_MS);
    const resolution = await pending;
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("timed-out");
  });

  test("deletes the exact item and reports whether it existed", async () => {
    const existing = secrets({ deleted: true });
    expect(await store(existing).removeSecret(reference())).toEqual({
      result: "removed",
      code: null,
    });
    expect(existing.calls()[0]).toEqual({
      kind: "delete",
      service: "falryn.provider.example",
      name: "work@example.com",
    });

    expect(await store(secrets({ deleted: false })).removeSecret(reference())).toEqual({
      result: "not-present",
      code: null,
    });
  });
});
