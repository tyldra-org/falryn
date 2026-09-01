import { describe, expect, test } from "bun:test";

import { MAX_CREDENTIAL_SECRET_BYTES } from "../domain/index.ts";
import type { OperatingSystemSecretsPort } from "./keychain-credentials.ts";
import { writeKeychainCredential } from "./keychain-write.ts";

function reference() {
  return {
    storeKind: "operating-system-keychain" as const,
    locator: "falryn.provider.openai",
    consumer: "provider:openai",
    accountLabel: "default",
  };
}

describe("writeKeychainCredential", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    test(`writes through the current user's operating-system vault on ${platform}`, async () => {
      const calls: unknown[] = [];
      const secrets: OperatingSystemSecretsPort = {
        get: async () => null,
        async set(options) {
          calls.push(options);
        },
        delete: async () => false,
      };
      const result = await writeKeychainCredential({
        platform,
        reference: reference(),
        secret: "sk-never-log-me",
        secrets,
      });
      expect(result).toEqual({ kind: "written" });
      expect(calls).toEqual([
        {
          service: "falryn.provider.openai",
          name: "default",
          value: "sk-never-log-me",
          allowUnrestrictedAccess: false,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("sk-never-log-me");
    });
  }

  test("refuses empty, oversized, malformed, and aborted writes", async () => {
    let calls = 0;
    const secrets: OperatingSystemSecretsPort = {
      get: async () => null,
      set: async () => {
        calls += 1;
      },
      delete: async () => false,
    };
    expect(
      await writeKeychainCredential({
        platform: "darwin",
        reference: reference(),
        secret: "",
        secrets,
      }),
    ).toEqual({ kind: "failed", code: "empty-secret" });
    expect(
      await writeKeychainCredential({
        platform: "darwin",
        reference: { ...reference(), locator: "bad\nlocator" },
        secret: "value",
        secrets,
      }),
    ).toEqual({ kind: "failed", code: "illegal-credential-identifier" });
    expect(
      await writeKeychainCredential({
        platform: "darwin",
        reference: reference(),
        secret: "x".repeat(MAX_CREDENTIAL_SECRET_BYTES + 1),
        secrets,
      }),
    ).toEqual({ kind: "failed", code: "secret-too-large" });
    const controller = new AbortController();
    controller.abort();
    expect(
      await writeKeychainCredential({
        platform: "darwin",
        reference: reference(),
        secret: "value",
        secrets,
        request: { signal: controller.signal },
      }),
    ).toEqual({ kind: "failed", code: "aborted-before-write" });
    expect(calls).toBe(0);
  });

  test("maps host failures without exposing native error text", async () => {
    const result = await writeKeychainCredential({
      platform: "linux",
      reference: reference(),
      secret: "value",
      secrets: {
        get: async () => null,
        set: async () => {
          throw new Error("native error containing host details");
        },
        delete: async () => false,
      },
    });
    expect(result).toEqual({ kind: "failed", code: "secrets-write-failed" });
  });
});
