/**
 * The resolver: routing, consumer binding, and the negative controls that prove
 * a secret reaches the callback and nothing else.
 *
 * The leakage sweep is deliberately blunt. It serializes every observable the
 * resolution produced — the returned value, the failure, the translated error,
 * and every diagnostic the collector retained — and asserts the secret's bytes
 * appear in none of them. A structural argument that they cannot is worth less
 * than a check that runs on every commit.
 */

import { describe, expect, test } from "bun:test";

import {
  type CredentialReference,
  type CredentialStorePort,
  createInMemoryCredentialStore,
  createManualClock,
} from "../domain/index.ts";
import { createSecretResolver } from "./credential-resolver.ts";
import { createDiagnosticsCollector } from "./diagnostics-collector.ts";
import { fromCredentialFailure } from "./error-translation.ts";

const SECRET = "sk-live-0123456789abcdef";
const LOCATOR = "falryn-example-provider";
const CONSUMER = "example-provider";

const REFERENCE: CredentialReference = {
  storeKind: "operating-system-keychain",
  locator: LOCATOR,
  consumer: CONSUMER,
  accountLabel: "work@example.com",
};

function harness(stores?: readonly CredentialStorePort[]) {
  const clock = createManualClock();
  const diagnostics = createDiagnosticsCollector({ clock });
  const resolver = createSecretResolver({
    stores: stores ?? [
      createInMemoryCredentialStore({
        storeKind: "operating-system-keychain",
        secrets: { [LOCATOR]: SECRET },
      }),
    ],
    clock,
    diagnostics,
  });
  return { resolver, diagnostics };
}

describe("routing", () => {
  test("resolves through the store the reference names", async () => {
    const { resolver } = harness();
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: CONSUMER },
      (secret) => secret.length,
    );

    expect(resolution.kind).toBe("resolved");
    expect(resolution.kind === "resolved" && resolution.value).toBe(SECRET.length);
  });

  test("a store kind no adapter is registered for is unsupported", async () => {
    const { resolver } = harness();
    const resolution = await resolver.resolve(
      { reference: { ...REFERENCE, storeKind: "provider-login" }, consumer: CONSUMER },
      (secret) => secret,
    );

    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("unsupported");
    expect(resolution.kind === "unresolved" && resolution.failure.code).toBe(
      "store-not-registered",
    );
  });

  test("a store that reports itself unsupported is never read", async () => {
    const { resolver } = harness([
      createInMemoryCredentialStore({
        storeKind: "operating-system-keychain",
        secrets: { [LOCATOR]: SECRET },
        availability: { kind: "unsupported", platform: "linux", reason: "not qualified" },
      }),
    ]);
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: CONSUMER },
      (secret) => secret,
    );

    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("unsupported");
    expect(resolution.kind === "unresolved" && resolution.failure.code).toBe("platform-linux");
  });

  test("two adapters for one store kind is a composition defect", () => {
    const clock = createManualClock();
    expect(() =>
      createSecretResolver({
        clock,
        stores: [
          createInMemoryCredentialStore({ storeKind: "environment" }),
          createInMemoryCredentialStore({ storeKind: "environment" }),
        ],
      }),
    ).toThrow(/duplicate credential store/);
  });
});

describe("consumer binding", () => {
  test("a consumer other than the declared one is denied before any store is asked", async () => {
    const { resolver, diagnostics } = harness();
    let used = false;
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: "other-provider" },
      (secret) => {
        used = true;
        return secret;
      },
    );

    expect(used).toBe(false);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("denied");
    expect(resolution.kind === "unresolved" && resolution.failure.code).toBe("consumer-mismatch");
    // The refusal is identical whether or not the credential exists, so a
    // mismatched consumer learns nothing about what is stored.
    expect(diagnostics.events().map((event) => event.code)).toEqual(["credential.denied"]);
  });

  test("the declared consumer is served", async () => {
    const { resolver } = harness();
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: CONSUMER },
      () => "used",
    );
    expect(resolution.kind).toBe("resolved");
  });
});

describe("cancellation", () => {
  test("an already-aborted request never reaches the store", async () => {
    const controller = new AbortController();
    controller.abort();
    const { resolver } = harness();
    let used = false;
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: CONSUMER },
      (secret) => {
        used = true;
        return secret;
      },
      { signal: controller.signal },
    );

    expect(used).toBe(false);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("cancelled");
    expect(resolution.kind === "unresolved" && resolution.failure.retryable).toBe(true);
  });
});

describe("diagnostics", () => {
  test("records the store kind and the consumer, and never the locator", async () => {
    const { resolver, diagnostics } = harness();
    await resolver.resolve({ reference: REFERENCE, consumer: CONSUMER }, () => "used");

    const [event] = diagnostics.events();
    expect(event?.subsystem).toBe("credentials");
    expect(event?.code).toBe("credential.resolved");
    expect(event?.metadata.storeKind).toBe("operating-system-keychain");
    expect(event?.metadata.consumer).toBe(CONSUMER);
    expect(JSON.stringify(event)).not.toContain(LOCATOR);
    expect(JSON.stringify(event)).not.toContain("work@example.com");
  });

  test("every unresolved status is recorded as its own series", async () => {
    for (const status of ["missing", "locked", "denied", "timed-out"] as const) {
      const { resolver, diagnostics } = harness([
        createInMemoryCredentialStore({
          storeKind: "operating-system-keychain",
          forcedStatus: status,
        }),
      ]);
      await resolver.resolve({ reference: REFERENCE, consumer: CONSUMER }, (secret) => secret);
      expect(diagnostics.events().map((event) => event.code)).toEqual([`credential.${status}`]);
    }
  });

  test("a resolver with no collector still resolves", async () => {
    const clock = createManualClock();
    const resolver = createSecretResolver({
      clock,
      stores: [
        createInMemoryCredentialStore({
          storeKind: "operating-system-keychain",
          secrets: { [LOCATOR]: SECRET },
        }),
      ],
    });
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: CONSUMER },
      (secret) => secret.length,
    );
    expect(resolution.kind === "resolved" && resolution.value).toBe(SECRET.length);
  });
});

describe("the secret reaches the callback and nothing else", () => {
  test("no returned value, health, diagnostic, or error carries it", async () => {
    const { resolver, diagnostics } = harness();
    let observed = "";
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: CONSUMER },
      (secret) => {
        observed = secret;
        // What the consumer needed, not the secret.
        return { authorized: true };
      },
    );

    // The callback did see it.
    expect(observed).toBe(SECRET);

    const sweep = JSON.stringify({
      resolution,
      diagnostics: diagnostics.events(),
      report: diagnostics.report(),
    });
    expect(sweep).not.toContain(SECRET);
    expect(sweep).not.toContain("sk-live");
    expect(sweep).not.toContain(LOCATOR);
  });

  test("a translated failure carries a status, a code, and no locator", async () => {
    const { resolver, diagnostics } = harness([
      createInMemoryCredentialStore({
        storeKind: "operating-system-keychain",
        secrets: { [LOCATOR]: SECRET },
        forcedStatus: "denied",
      }),
    ]);
    const resolution = await resolver.resolve(
      { reference: REFERENCE, consumer: CONSUMER },
      (secret) => secret,
    );
    if (resolution.kind !== "unresolved") {
      throw new Error("expected an unresolved outcome");
    }

    const error = fromCredentialFailure(resolution.failure);
    expect(error.category).toBe("authentication");
    expect(error.code).toBe("authentication.denied");
    expect(error.exitCategory).toBe("user-error");
    expect(error.effect).toBe("none");

    const sweep = JSON.stringify({ error, diagnostics: diagnostics.events() });
    expect(sweep).not.toContain(SECRET);
    expect(sweep).not.toContain(LOCATOR);
    expect(sweep).not.toContain("work@example.com");
  });

  test("a callback that throws does not turn the secret into an error message", async () => {
    const { resolver } = harness();
    let thrown: unknown = null;
    try {
      await resolver.resolve({ reference: REFERENCE, consumer: CONSUMER }, (secret) => {
        throw new Error(`consumer failed while holding ${secret.length} characters`);
      });
    } catch (error) {
      thrown = error;
    }

    // The throw propagates — the resolver does not swallow a consumer's failure
    // — and what propagates is the consumer's own message.
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).not.toContain(SECRET);
  });
});
