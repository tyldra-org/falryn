import { describe, expect, test } from "bun:test";

import { instant, providerId } from "../domain/index.ts";
import {
  AUTHORIZED_LOGIN_SCHEMA_VERSION,
  parseAuthorizedProviderCredential,
  parseAuthorizedProviderLoginDescriptor,
  parseProviderAuthorizationReceipt,
} from "./index.ts";

describe("authorized login codecs", () => {
  test("accepts a complete adapter descriptor and rejects callback contradictions", () => {
    const descriptor = {
      schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
      adapterId: "fixture-login",
      providerId: providerId.from("fixture"),
      adapterKind: "openai",
      methods: ["oauth-pkce"] as const,
      scopes: ["models.read"],
      callbackModes: ["loopback"] as const,
      loopbackRedirectUri: null,
      manualRedirectUri: null,
      refresh: true,
      revoke: true,
      accountLookup: false,
      revision: "fixture-v1",
    };
    expect(parseAuthorizedProviderLoginDescriptor(descriptor).ok).toBe(true);
    expect(
      parseAuthorizedProviderLoginDescriptor({
        ...descriptor,
        loopbackRedirectUri: "http://127.0.0.1:43123/provider/callback",
      }).ok,
    ).toBe(true);
    expect(
      parseAuthorizedProviderLoginDescriptor({
        ...descriptor,
        loopbackRedirectUri: "http://localhost:43123/provider/callback",
      }).ok,
    ).toBe(false);
    expect(
      parseAuthorizedProviderLoginDescriptor({
        ...descriptor,
        callbackModes: ["manual-code"],
      }).ok,
    ).toBe(false);
    expect(parseAuthorizedProviderLoginDescriptor({ ...descriptor, secret: "forbidden" }).ok).toBe(
      false,
    );
  });

  test("keeps credential values out of codec errors", () => {
    const secret = "access-token-must-not-appear";
    const parsed = parseAuthorizedProviderCredential({
      schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
      kind: "authorized-provider",
      accessToken: secret,
      refreshToken: null,
      tokenType: "Bearer",
      scopes: ["models.read", "models.read"],
      issuedAt: instant(100),
      expiresAt: instant(50),
    });
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });

  test("accepts one terminal receipt and rejects time reversal", () => {
    const receipt = {
      schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
      attemptId: "auth-1",
      adapterId: "fixture-login",
      adapterGeneration: 2,
      providerId: "fixture",
      profileId: "fixture-work",
      method: "device-code" as const,
      startedAt: instant(100),
      finishedAt: instant(200),
      outcome: "authorized" as const,
      code: null,
    };
    expect(parseProviderAuthorizationReceipt(receipt).ok).toBe(true);
    expect(parseProviderAuthorizationReceipt({ ...receipt, finishedAt: instant(99) }).ok).toBe(
      false,
    );
  });
});
