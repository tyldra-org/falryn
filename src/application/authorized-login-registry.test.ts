import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/index.ts";
import {
  AUTHORIZED_LOGIN_SCHEMA_VERSION,
  type ProviderAuthorizedLoginAdapter,
  type ProviderProfile,
} from "../providers/index.ts";
import { createAuthorizedLoginAdapterRegistry } from "./authorized-login-registry.ts";

function profile(): ProviderProfile {
  return {
    profileId: "fixture-work",
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

function adapter(
  id: string,
  availability: ProviderAuthorizedLoginAdapter["availability"] = () => ({ kind: "available" }),
): ProviderAuthorizedLoginAdapter {
  return {
    descriptor: {
      schemaVersion: AUTHORIZED_LOGIN_SCHEMA_VERSION,
      adapterId: id,
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
    availability,
    beginDeviceCode: async () => ({
      kind: "failed",
      code: "fixture-not-started",
      retryable: false,
    }),
    pollDeviceCode: async () => ({
      kind: "failed",
      code: "fixture-not-polled",
      retryable: false,
    }),
  };
}

describe("authorized login adapter registry", () => {
  test("binds an immutable generation while later resolutions use the replacement", () => {
    const first = adapter("fixture-v1");
    const second = adapter("fixture-v2");
    const registry = createAuthorizedLoginAdapterRegistry([first]);
    const bound = registry.resolve(profile(), "device-code");
    expect(bound).toMatchObject({ kind: "available", binding: { generation: 1 } });

    registry.replace([second]);
    expect(registry.resolve(profile(), "device-code")).toMatchObject({
      kind: "available",
      binding: { generation: 2, adapter: { descriptor: { adapterId: "fixture-v2" } } },
    });
    expect(bound).toMatchObject({
      kind: "available",
      binding: { adapter: { descriptor: { adapterId: "fixture-v1" } } },
    });
    (first.descriptor.methods as string[]).length = 0;
    expect(bound).toMatchObject({
      kind: "available",
      binding: { adapter: { descriptor: { methods: ["device-code"] } } },
    });
  });

  test("reports dynamic unavailability and keeps unavailable methods out of discovery", () => {
    const registry = createAuthorizedLoginAdapterRegistry([
      adapter("fixture-disabled", () => ({ kind: "unavailable", code: "subscription-disabled" })),
    ]);
    expect(registry.methods(profile())).toEqual([]);
    expect(registry.resolve(profile(), "device-code")).toEqual({
      kind: "unavailable",
      code: "subscription-disabled",
    });

    const throwing = createAuthorizedLoginAdapterRegistry([
      adapter("fixture-throwing", () => {
        throw new Error("private provider detail");
      }),
    ]);
    expect(throwing.methods(profile())).toEqual([]);
    expect(throwing.resolve(profile(), "device-code")).toEqual({
      kind: "unavailable",
      code: "authorized-login-adapter-threw",
    });
  });

  test("rejects duplicate routes and incomplete runtime adapters", () => {
    expect(() => createAuthorizedLoginAdapterRegistry([adapter("one"), adapter("two")])).toThrow(
      "duplicate authorized-login route",
    );
    expect(() =>
      createAuthorizedLoginAdapterRegistry([
        {
          ...adapter("missing"),
          availability: undefined,
        } as unknown as ProviderAuthorizedLoginAdapter,
      ]),
    ).toThrow("lacks availability");
  });
});
