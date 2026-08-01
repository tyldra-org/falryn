/**
 * Credential references as configuration: how one is declared, how one is read
 * out of an effective configuration, and how one is removed.
 *
 * Every store here is in-memory. Nothing in this file reaches a keychain, a
 * process, or an environment variable.
 */

import { describe, expect, test } from "bun:test";

import { createRuntimeRedactor, REDACTED } from "../application/index.ts";
import {
  type ConfigurationIssue,
  type ConfigurationLayerContext,
  type ConfigurationValues,
  type CredentialReference,
  createInMemoryCredentialStore,
  credentialRemovalIdentity,
} from "../domain/index.ts";
import {
  createInMemoryReferenceStore,
  parseCredentialReference,
  readCredentialReference,
  removeCredential,
} from "./credentials.ts";
import { credentialReferenceKey, integerKey } from "./declaration.ts";
import { createConfigurationRegistry } from "./registry.ts";

const CREDENTIAL_PATH = "provider.credential";

const CREDENTIAL_KEY = credentialReferenceKey({
  path: CREDENTIAL_PATH,
  summary: "A credential reference for a provider.",
  scopes: ["user", "profile", "environment"],
  applicationClass: "next-turn",
});

const PLAIN_KEY = integerKey({
  path: "provider.retries",
  summary: "A public value beside the credential.",
  unit: "items",
  minimum: 0,
  maximum: 10,
  defaultValue: 3,
  scopes: ["user", "project"],
  applicationClass: "live",
});

const USER_LAYER: ConfigurationLayerContext = { scope: "user", sourceKind: "user-file" };
const PROJECT_LAYER: ConfigurationLayerContext = { scope: "project", sourceKind: "project-file" };

const REFERENCE: CredentialReference = {
  storeKind: "operating-system-keychain",
  locator: "falryn-provider",
  consumer: "example-provider",
  accountLabel: "work",
};

function registry() {
  return createConfigurationRegistry({
    declarations: [CREDENTIAL_KEY, PLAIN_KEY],
    redactor: createRuntimeRedactor(),
  });
}

function kinds(issues: readonly ConfigurationIssue[]): readonly string[] {
  return issues.map((issue) => issue.kind);
}

describe("declaring a credential key", () => {
  test("forces the credential-reference sensitivity", () => {
    expect(CREDENTIAL_KEY.descriptor.sensitivity).toBe("credential-reference");
  });

  test("defaults to no credential rather than to a placeholder locator", () => {
    expect(CREDENTIAL_KEY.descriptor.defaultValue).toBeNull();
  });

  test("refuses to be declared settable from project scope", () => {
    expect(() =>
      credentialReferenceKey({
        path: "provider.leaked",
        summary: "A credential a project file could set.",
        scopes: ["user", "project"],
        applicationClass: "next-turn",
      }),
    ).toThrow(/project scope/);
  });

  test("accepts a complete reference", () => {
    const parsed = CREDENTIAL_KEY.validate(REFERENCE);
    expect(parsed.ok).toBe(true);
  });

  test("rejects a bare secret with a named plaintext diagnostic", () => {
    const parsed = CREDENTIAL_KEY.validate("sk-live-abcdefghijklmnop");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error("expected a rejection");
    }
    expect(kinds(parsed.error)).toEqual(["plaintext-credential"]);
    // The diagnostic reports the constraint, never what was written.
    expect(JSON.stringify(parsed.error)).not.toContain("sk-live");
  });

  test("rejects a secret smuggled in beside the reference", () => {
    const parsed = CREDENTIAL_KEY.validate({ ...REFERENCE, apiKey: "sk-live-abcdefghijklmnop" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error("expected a rejection");
    }
    expect(kinds(parsed.error)).toEqual(["unknown-key"]);
    expect(JSON.stringify(parsed.error)).not.toContain("sk-live");
  });

  test("rejects a store kind nothing declares", () => {
    const parsed = CREDENTIAL_KEY.validate({ ...REFERENCE, storeKind: "sticky-note" });
    expect(parsed.ok).toBe(false);
  });
});

describe("a project file cannot supply a credential", () => {
  test("setting the key from project scope is refused", () => {
    const result = registry().validateLayer(
      { schemaVersion: 1, provider: { credential: REFERENCE } },
      PROJECT_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(kinds(result.issues)).toEqual(["scope-unavailable"]);
  });

  test("a plaintext credential in a project file is refused and never adopted", () => {
    const result = registry().validateLayer(
      { schemaVersion: 1, provider: { credential: "sk-live-abcdefghijklmnop" } },
      PROJECT_LAYER,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.issues)).not.toContain("sk-live");
  });

  test("a user file may still set it", () => {
    const result = registry().validateLayer(
      { schemaVersion: 1, provider: { credential: REFERENCE } },
      USER_LAYER,
    );
    expect(result.ok).toBe(true);
  });
});

describe("reading a reference out of an effective configuration", () => {
  const values: ConfigurationValues = {
    [CREDENTIAL_PATH]: { ...REFERENCE },
    "provider.retries": 3,
  };

  test("returns the declared reference", () => {
    const lookup = readCredentialReference(registry(), values, CREDENTIAL_PATH);
    expect(lookup).toEqual({ kind: "declared", reference: REFERENCE });
  });

  test("an unset key is unset rather than undeclared", () => {
    const lookup = readCredentialReference(
      registry(),
      { [CREDENTIAL_PATH]: null },
      CREDENTIAL_PATH,
    );
    expect(lookup.kind).toBe("unset");
  });

  test("a key nothing declares is undeclared rather than unset", () => {
    expect(readCredentialReference(registry(), values, "provider.absent").kind).toBe("undeclared");
  });

  test("a key that is not a credential key cannot be read as one", () => {
    // Otherwise any public value could be routed into a store lookup.
    expect(readCredentialReference(registry(), values, "provider.retries").kind).toBe("undeclared");
  });

  test("a composed value that is not a reference is malformed, not a credential", () => {
    const lookup = readCredentialReference(
      registry(),
      { [CREDENTIAL_PATH]: "sk-live-abcdefghijklmnop" },
      CREDENTIAL_PATH,
    );
    expect(lookup.kind).toBe("malformed");
    expect(JSON.stringify(lookup)).not.toContain("sk-live");
  });

  test("an unknown store kind is reported against the store-kind field", () => {
    const parsed = parseCredentialReference(
      { ...REFERENCE, storeKind: "sticky-note" },
      CREDENTIAL_PATH,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error("expected a rejection");
    }
    expect(parsed.error[0]?.path).toBe(`${CREDENTIAL_PATH}.storeKind`);
  });
});

describe("rendering a reference", () => {
  test("shows presence and withholds the locator", () => {
    const rendered = registry().render(CREDENTIAL_PATH, { ...REFERENCE });
    expect(rendered).toEqual({
      storeKind: "operating-system-keychain",
      consumer: "example-provider",
      accountLabel: "work",
      locator: REDACTED,
      present: true,
    });
  });
});

describe("removing a credential", () => {
  function stores(options: { readonly failSecret?: boolean } = {}) {
    return {
      store: createInMemoryCredentialStore({
        storeKind: "operating-system-keychain",
        secrets: { [REFERENCE.locator]: "stored-secret" },
        removalFailures: options.failSecret === true ? [REFERENCE.locator] : [],
      }),
      references: createInMemoryReferenceStore({ [CREDENTIAL_PATH]: REFERENCE }),
    };
  }

  const confirmation = { identity: credentialRemovalIdentity(REFERENCE) };

  test("removes the secret and the reference as two reported halves", async () => {
    const { store, references } = stores();
    const outcome = await removeCredential({
      reference: REFERENCE,
      confirmation,
      store,
      references,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected a removal outcome");
    }
    expect(outcome.value.secret.result).toBe("removed");
    expect(outcome.value.reference.result).toBe("removed");
    expect(outcome.value.completeness).toBe("completed");
    expect(references.remaining()).toEqual([]);
  });

  test("a secret this store cannot delete leaves the removal partial", async () => {
    const outcome = await removeCredential({
      reference: REFERENCE,
      confirmation,
      // An environment reference has no stored secret a process can delete.
      store: createInMemoryCredentialStore({
        storeKind: "environment",
        availability: { kind: "unsupported", platform: "linux", reason: "not writable" },
      }),
      references: createInMemoryReferenceStore({ [CREDENTIAL_PATH]: REFERENCE }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected a removal outcome");
    }
    expect(outcome.value.secret.result).toBe("unsupported");
    expect(outcome.value.reference.result).toBe("removed");
    expect(outcome.value.completeness).toBe("partial");
  });

  test("a failed secret deletion never orphans the secret by removing its reference", async () => {
    const { store, references } = stores({ failSecret: true });
    const outcome = await removeCredential({
      reference: REFERENCE,
      confirmation,
      store,
      references,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected a removal outcome");
    }
    expect(outcome.value.secret.result).toBe("failed");
    expect(outcome.value.reference.result).toBe("not-attempted");
    expect(outcome.value.completeness).toBe("failed");
    // The reference still names the secret that is still there.
    expect(references.remaining()).toEqual([CREDENTIAL_PATH]);
  });

  test("a reference already gone still reports a completed removal", async () => {
    const { store } = stores();
    const outcome = await removeCredential({
      reference: REFERENCE,
      confirmation,
      store,
      references: createInMemoryReferenceStore({}),
    });

    expect(outcome.ok && outcome.value.reference.result).toBe("not-present");
    expect(outcome.ok && outcome.value.completeness).toBe("completed");
  });

  test("a confirmation naming a different reference is refused", async () => {
    const { store, references } = stores();
    const outcome = await removeCredential({
      reference: REFERENCE,
      confirmation: { identity: credentialRemovalIdentity({ ...REFERENCE, locator: "other" }) },
      store,
      references,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a refusal");
    }
    expect(outcome.error.code).toBe("confirmation-mismatch");
    // Nothing was touched.
    expect(references.remaining()).toEqual([CREDENTIAL_PATH]);
  });

  test("a cancelled removal deletes nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { store, references } = stores();
    const outcome = await removeCredential(
      { reference: REFERENCE, confirmation, store, references },
      { signal: controller.signal },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a refusal");
    }
    expect(outcome.error.code).toBe("cancelled");
    expect(references.remaining()).toEqual([CREDENTIAL_PATH]);
  });
});
