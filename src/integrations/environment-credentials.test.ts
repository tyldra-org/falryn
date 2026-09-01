/**
 * The environment-reference store.
 *
 * The variable map is supplied through `EnvironmentPort`, so nothing here reads
 * or mutates `process.env`.
 */

import { describe, expect, test } from "bun:test";

import {
  type CredentialReference,
  createManualClock,
  createStaticEnvironment,
  MAX_CREDENTIAL_SECRET_BYTES,
} from "../domain/index.ts";
import { createEnvironmentCredentialStore } from "./environment-credentials.ts";
import type { SessionEnvironmentCredentialLookupPort } from "./session-environment-credentials.ts";

function store(values: Readonly<Record<string, string>> = {}) {
  return createEnvironmentCredentialStore({
    environment: createStaticEnvironment(values),
    clock: createManualClock(),
  });
}

function aliasedStore(values: Readonly<Record<string, string>> = {}) {
  return createEnvironmentCredentialStore({
    environment: createStaticEnvironment(values),
    clock: createManualClock(),
    aliases: { FALRYN_PROVIDER_TOKEN: ["PROVIDER_TOKEN", "LEGACY_PROVIDER_TOKEN"] },
  });
}

function reference(overrides: Partial<CredentialReference> = {}): CredentialReference {
  return {
    storeKind: "environment",
    locator: "FALRYN_PROVIDER_TOKEN",
    consumer: "example-provider",
    accountLabel: null,
    ...overrides,
  };
}

describe("the environment credential store", () => {
  test("is available on every platform", () => {
    expect(store().availability()).toEqual({ kind: "available" });
  });

  test("resolves a variable that is set", async () => {
    const resolution = await store({ FALRYN_PROVIDER_TOKEN: "sk-live-value" }).read(
      reference(),
      (secret) => secret.length,
    );

    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") {
      throw new Error("expected a resolved outcome");
    }
    expect(resolution.value).toBe("sk-live-value".length);
    expect(resolution.health.state).toBe("present");
    expect(JSON.stringify(resolution)).not.toContain("sk-live");
  });

  test("reports an unset variable as missing", async () => {
    const resolution = await store().read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("missing");
    expect(resolution.kind === "unresolved" && resolution.failure.health.state).toBe("absent");
  });

  test("never scans for variables that merely look like credentials", async () => {
    // `API_KEY` is set and is not the declared locator, so it is not a
    // credential — a variable becoming one by being spelled a certain way is
    // exactly what this store refuses to do.
    const resolution = await store({ API_KEY: "sk-live-value" }).read(
      reference(),
      (secret) => secret,
    );
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("missing");
  });

  test("uses only declared aliases when the canonical variable is absent", async () => {
    const resolution = await aliasedStore({ PROVIDER_TOKEN: "from-provider" }).read(
      reference(),
      (secret) => secret,
    );
    expect(resolution.kind === "resolved" && resolution.value).toBe("from-provider");
  });

  test("gives the canonical Falryn variable precedence over provider aliases", async () => {
    const resolution = await aliasedStore({
      FALRYN_PROVIDER_TOKEN: "from-falryn",
      PROVIDER_TOKEN: "from-provider",
    }).read(reference(), (secret) => secret);
    expect(resolution.kind === "resolved" && resolution.value).toBe("from-falryn");
  });

  test("falls back to exact-name session lookup in declared order", async () => {
    const reads: string[] = [];
    const session: SessionEnvironmentCredentialLookupPort = {
      async read(variable) {
        reads.push(variable);
        return variable === "PROVIDER_TOKEN"
          ? { kind: "found", value: "from-session" }
          : { kind: "missing" };
      },
    };
    const resolution = await createEnvironmentCredentialStore({
      environment: createStaticEnvironment({}),
      clock: createManualClock(),
      aliases: { FALRYN_PROVIDER_TOKEN: ["PROVIDER_TOKEN", "LEGACY_PROVIDER_TOKEN"] },
      session,
    }).read(reference(), (secret) => secret);
    expect(resolution.kind === "resolved" && resolution.value).toBe("from-session");
    expect(reads).toEqual(["FALRYN_PROVIDER_TOKEN", "PROVIDER_TOKEN"]);
  });

  test("never consults session state when an inherited value exists", async () => {
    let used = false;
    const session: SessionEnvironmentCredentialLookupPort = {
      async read() {
        used = true;
        return { kind: "found", value: "wrong" };
      },
    };
    const resolution = await createEnvironmentCredentialStore({
      environment: createStaticEnvironment({ FALRYN_PROVIDER_TOKEN: "inherited" }),
      clock: createManualClock(),
      session,
    }).read(reference(), (secret) => secret);
    expect(resolution.kind === "resolved" && resolution.value).toBe("inherited");
    expect(used).toBe(false);
  });

  test("refuses malformed aliases instead of probing them", async () => {
    const malformed = createEnvironmentCredentialStore({
      environment: createStaticEnvironment({}),
      clock: createManualClock(),
      aliases: { FALRYN_PROVIDER_TOKEN: ["bad alias"] },
    });
    const resolution = await malformed.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure).toMatchObject({
      status: "malformed",
      code: "illegal-variable-alias",
    });
  });

  test("refuses a locator that is not a legal variable name", async () => {
    for (const locator of ["lowercase", "WITH SPACE", "-DASH", "WITH;SEMICOLON", ""]) {
      const resolution = await store().read(reference({ locator }), (secret) => secret);
      expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("malformed");
    }
  });

  test("refuses a value larger than a credential can be", async () => {
    const oversized = "x".repeat(MAX_CREDENTIAL_SECRET_BYTES + 1);
    const resolution = await store({ FALRYN_PROVIDER_TOKEN: oversized }).read(
      reference(),
      (secret) => secret,
    );
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("malformed");
  });

  test("an already-aborted read never touches the environment", async () => {
    const controller = new AbortController();
    controller.abort();
    let used = false;
    const resolution = await store({ FALRYN_PROVIDER_TOKEN: "value" }).read(
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

  test("cannot delete a secret, and says so rather than reporting success", async () => {
    expect(await store({ FALRYN_PROVIDER_TOKEN: "value" }).removeSecret(reference())).toEqual({
      result: "unsupported",
      code: "environment-not-writable",
    });
  });
});
