/**
 * The credential contract's own rules: what a status implies about health, what
 * authorizes a removal, and that the in-memory store every other test resolves
 * against reproduces the full state matrix.
 */

import { describe, expect, test } from "bun:test";

import {
  CREDENTIAL_UNRESOLVED_STATUSES,
  type CredentialReference,
  createInMemoryCredentialStore,
  credentialRemovalIdentity,
  healthForStatus,
  instant,
  unknownHealth,
} from "./index.ts";

const AT = instant(1_700_000_000_000);

function reference(overrides: Partial<CredentialReference> = {}): CredentialReference {
  return {
    storeKind: "environment",
    locator: "FALRYN_TEST_TOKEN",
    consumer: "test-provider",
    accountLabel: null,
    ...overrides,
  };
}

describe("health inferred from a status", () => {
  test("only a store that answered can prove absence", () => {
    expect(healthForStatus("missing", "environment", AT).state).toBe("absent");
    expect(healthForStatus("empty", "environment", AT).state).toBe("absent");
  });

  test("a store that refused or could not be reached proves nothing about presence", () => {
    for (const status of ["locked", "denied", "unavailable", "unsupported", "timed-out"] as const) {
      expect(healthForStatus(status, "operating-system-keychain", AT).state).toBe("unreachable");
    }
  });

  test("a cancelled or malformed lookup observed nothing at all", () => {
    for (const status of ["cancelled", "malformed"] as const) {
      const health = healthForStatus(status, "environment", AT);
      expect(health.state).toBe("unknown");
      // No observation happened, so recording when it happened would be a lie.
      expect(health.observedAt).toBeNull();
    }
  });

  test("every declared status maps to a health state", () => {
    for (const status of CREDENTIAL_UNRESOLVED_STATUSES) {
      expect(healthForStatus(status, "environment", AT).state).not.toBeUndefined();
    }
  });

  test("health before any lookup is unknown rather than absent", () => {
    expect(unknownHealth("environment")).toEqual({
      state: "unknown",
      storeKind: "environment",
      observedAt: null,
    });
  });
});

describe("removal identity", () => {
  test("is derived from the reference's own content", () => {
    expect(credentialRemovalIdentity(reference())).toBe(
      '["environment","FALRYN_TEST_TOKEN","test-provider",null]',
    );
  });

  test("two references cannot share an identity by containing its separator", () => {
    // A joined string would collide here; the encoded form cannot.
    expect(credentialRemovalIdentity(reference({ locator: 'a","b' }))).not.toBe(
      credentialRemovalIdentity(reference({ locator: "a", consumer: "b" })),
    );
  });

  test("changes when any field of the reference changes", () => {
    const base = credentialRemovalIdentity(reference());
    expect(credentialRemovalIdentity(reference({ locator: "OTHER" }))).not.toBe(base);
    expect(credentialRemovalIdentity(reference({ consumer: "other" }))).not.toBe(base);
    expect(credentialRemovalIdentity(reference({ accountLabel: "work" }))).not.toBe(base);
    expect(credentialRemovalIdentity(reference({ storeKind: "local-file" }))).not.toBe(base);
  });
});

describe("the in-memory store", () => {
  test("hands the secret to the callback and returns only its result", async () => {
    const store = createInMemoryCredentialStore({
      storeKind: "environment",
      secrets: { FALRYN_TEST_TOKEN: "sk-live-secret-value" },
    });
    const resolution = await store.read(reference(), (secret) => secret.length);

    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") {
      throw new Error("expected a resolved outcome");
    }
    expect(resolution.value).toBe("sk-live-secret-value".length);
    expect(JSON.stringify(resolution)).not.toContain("sk-live");
  });

  test("reports a locator it holds nothing for as missing", async () => {
    const store = createInMemoryCredentialStore({ storeKind: "environment" });
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("missing");
  });

  test("distinguishes an entry that is empty from one that is absent", async () => {
    const store = createInMemoryCredentialStore({
      storeKind: "environment",
      secrets: { FALRYN_TEST_TOKEN: "" },
    });
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("empty");
  });

  test("reproduces every unresolved status on demand", async () => {
    for (const status of CREDENTIAL_UNRESOLVED_STATUSES) {
      const store = createInMemoryCredentialStore({
        storeKind: "environment",
        secrets: { FALRYN_TEST_TOKEN: "value" },
        forcedStatus: status,
      });
      const resolution = await store.read(reference(), (secret) => secret);
      expect(resolution.kind === "unresolved" && resolution.failure.status).toBe(status);
    }
  });

  test("an already-aborted request never reaches the store", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = createInMemoryCredentialStore({
      storeKind: "environment",
      secrets: { FALRYN_TEST_TOKEN: "value" },
    });
    let used = false;
    const resolution = await store.read(
      reference(),
      (secret) => {
        used = true;
        return secret;
      },
      { signal: controller.signal },
    );

    expect(used).toBe(false);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("cancelled");
  });

  test("an unsupported store never reads and never removes", async () => {
    const store = createInMemoryCredentialStore({
      storeKind: "operating-system-keychain",
      secrets: { FALRYN_TEST_TOKEN: "value" },
      availability: { kind: "unsupported", platform: "linux", reason: "not qualified" },
    });
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("unsupported");
    expect((await store.removeSecret(reference())).result).toBe("unsupported");
  });

  test("removing a secret twice reports removed and then not-present", async () => {
    const store = createInMemoryCredentialStore({
      storeKind: "environment",
      secrets: { FALRYN_TEST_TOKEN: "value" },
    });
    expect((await store.removeSecret(reference())).result).toBe("removed");
    expect((await store.removeSecret(reference())).result).toBe("not-present");
  });
});
