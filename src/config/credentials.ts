/**
 * Reading a credential reference out of an effective configuration, and
 * removing one.
 *
 * #8 composed six layers into one validated generation. This module answers the
 * next question a consumer asks: *is a credential configured for me, and what
 * does it point at?* It reaches no store. Turning a reference into a secret is
 * the resolver's, and reaching a keychain is an integration leaf's.
 *
 * Reading a reference is deliberately a lookup rather than a search. There is
 * no "find the credential for provider X" over the whole configuration: a
 * consumer names the key it declared, and a key nothing declared is an
 * undeclared key rather than a near-match. Guessing which of two credential
 * keys a caller meant is guessing which secret to hand it.
 */

import {
  type ConfigurationIssue,
  type ConfigurationRegistryPort,
  type ConfigurationValue,
  type ConfigurationValues,
  CREDENTIAL_STORE_KINDS,
  type CredentialPartOutcome,
  type CredentialReference,
  type CredentialReferenceStorePort,
  type CredentialRemovalCompleteness,
  type CredentialRemovalConfirmation,
  type CredentialRemovalOutcome,
  type CredentialRemovalRefusal,
  type CredentialRequestOptions,
  type CredentialStoreKind,
  type CredentialStorePort,
  credentialRemovalIdentity,
  err,
  MAX_CREDENTIAL_LABEL_LENGTH,
  MAX_CREDENTIAL_LOCATOR_LENGTH,
  ok,
  type Result,
} from "../domain/index.ts";

/**
 * What an effective configuration says about one credential key.
 *
 * `unset` and `undeclared` are separate answers: the first means the key exists
 * and nobody configured a credential, and the second means the caller asked for
 * a key this build does not have. A consumer that treated them the same would
 * report "no credential configured" for its own typo.
 */
export type CredentialReferenceLookup =
  | { readonly kind: "declared"; readonly reference: CredentialReference }
  | { readonly kind: "unset" }
  | { readonly kind: "undeclared" }
  /** The key is declared, and the composed value is not a usable reference. */
  | { readonly kind: "malformed"; readonly issues: readonly ConfigurationIssue[] };

/**
 * Resolves one credential key against an effective configuration.
 *
 * The registry is consulted first, so a key whose sensitivity is not
 * `credential-reference` is refused rather than read: reading an arbitrary
 * public key as a credential reference would let a consumer route a
 * non-credential value into a store lookup.
 */
export function readCredentialReference(
  registry: ConfigurationRegistryPort,
  values: ConfigurationValues,
  path: string,
): CredentialReferenceLookup {
  const descriptor = registry.describe(path);
  if (descriptor === null || descriptor.sensitivity !== "credential-reference") {
    return { kind: "undeclared" };
  }
  const value = values[descriptor.path];
  if (value === undefined || value === null) {
    return { kind: "unset" };
  }
  const parsed = parseCredentialReference(value, descriptor.path);
  return parsed.ok
    ? { kind: "declared", reference: parsed.value }
    : { kind: "malformed", issues: parsed.error };
}

/**
 * Reads a composed value as a reference.
 *
 * The declaration's Zod type already rejected anything malformed on the way in,
 * so this is the second gate rather than the first. It exists because a
 * composed value reaches consumers through `ConfigurationValues`, whose element
 * type is "any JSON value" — narrowing it with a cast instead of a check would
 * make the contract a comment.
 */
export function parseCredentialReference(
  value: ConfigurationValue,
  path: string,
): Result<CredentialReference, readonly ConfigurationIssue[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err([
      {
        kind: "plaintext-credential",
        severity: "error",
        path,
        expectedStoreKinds: CREDENTIAL_STORE_KINDS,
      },
    ]);
  }
  const record = value as { readonly [key: string]: ConfigurationValue };
  const storeKind = record.storeKind;
  if (
    typeof storeKind !== "string" ||
    !(CREDENTIAL_STORE_KINDS as readonly string[]).includes(storeKind)
  ) {
    return err([
      {
        kind: "invalid-value",
        severity: "error",
        path: `${path}.storeKind`,
        allowed: [...CREDENTIAL_STORE_KINDS],
      },
    ]);
  }
  const locator = boundedString(record.locator, MAX_CREDENTIAL_LOCATOR_LENGTH);
  const consumer = boundedString(record.consumer, MAX_CREDENTIAL_LABEL_LENGTH);
  if (locator === null) {
    return err([shapeIssue(`${path}.locator`, MAX_CREDENTIAL_LOCATOR_LENGTH)]);
  }
  if (consumer === null) {
    return err([shapeIssue(`${path}.consumer`, MAX_CREDENTIAL_LABEL_LENGTH)]);
  }
  const accountLabel =
    record.accountLabel === null || record.accountLabel === undefined
      ? null
      : boundedString(record.accountLabel, MAX_CREDENTIAL_LABEL_LENGTH);
  if (record.accountLabel !== null && record.accountLabel !== undefined && accountLabel === null) {
    return err([shapeIssue(`${path}.accountLabel`, MAX_CREDENTIAL_LABEL_LENGTH)]);
  }

  return ok({
    storeKind: storeKind as CredentialStoreKind,
    locator,
    consumer,
    accountLabel,
  });
}

function boundedString(value: ConfigurationValue | undefined, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function shapeIssue(path: string, maximum: number): ConfigurationIssue {
  return { kind: "out-of-range", severity: "error", path, unit: null, minimum: 1, maximum };
}

export type CredentialRemovalRequest = {
  readonly reference: CredentialReference;
  /** Must carry the identity derived from this exact reference. */
  readonly confirmation: CredentialRemovalConfirmation;
  readonly store: CredentialStorePort;
  readonly references: CredentialReferenceStorePort;
};

/**
 * Deletes a credential locally: the stored secret, then the reference to it.
 *
 * **The secret goes first.** If the reference were removed first and secret
 * deletion then failed, the machine would hold a secret nothing names and
 * nothing can find again — the worst of the four possible end states. Doing it
 * in this order means the failure mode is a reference pointing at a secret that
 * is already gone, which is visible on the next resolution and fixable by hand.
 *
 * Remote revocation is not attempted and is not implied. Deleting the local
 * copy of a credential does not invalidate it at the provider; that is #35.
 */
export async function removeCredential(
  request: CredentialRemovalRequest,
  options?: CredentialRequestOptions,
): Promise<Result<CredentialRemovalOutcome, CredentialRemovalRefusal>> {
  const expected = credentialRemovalIdentity(request.reference);
  if (request.confirmation.identity !== expected) {
    // A reference edited between being shown and being confirmed derives a
    // different identity, so the confirmation no longer authorizes it.
    return err({
      code: "confirmation-mismatch",
      expected,
      confirmed: request.confirmation.identity,
    });
  }
  if (options?.signal?.aborted === true) {
    return err({ code: "cancelled" });
  }

  const secret = await request.store.removeSecret(request.reference, options);
  if (secret.result === "failed") {
    // Nothing was deleted, so the reference still names something real. Leaving
    // it is the recoverable state; removing it now would orphan the secret.
    return ok({
      secret,
      reference: { result: "not-attempted", code: "secret-removal-failed" },
      completeness: "failed",
    });
  }

  const reference = await request.references.removeReference(request.reference, options);
  return ok({ secret, reference, completeness: completenessOf(secret, reference) });
}

/**
 * How much of the removal happened.
 *
 * `unsupported` counts as neither success nor failure on its own: an
 * environment reference has no stored secret this process can delete, and
 * reporting that as a failure would make an ordinary, correct outcome look
 * broken. It still prevents `completed`, because half the credential is still
 * wherever it was.
 */
function completenessOf(
  secret: CredentialPartOutcome,
  reference: CredentialPartOutcome,
): CredentialRemovalCompleteness {
  const done = (part: CredentialPartOutcome): boolean =>
    part.result === "removed" || part.result === "not-present";
  if (done(secret) && done(reference)) {
    return "completed";
  }
  if (!done(secret) && !done(reference)) {
    return "failed";
  }
  return "partial";
}

/**
 * An in-memory reference store for tests and for the removal's second half.
 *
 * Configuration writing does not exist yet — #8 excluded it because nothing in
 * v0.1 sets a value — so this is the only supplier of the reference half today.
 * It is exported rather than hidden in a test file because the removal contract
 * is only demonstrable with something on the other side of the port.
 */
export function createInMemoryReferenceStore(
  paths: Readonly<Record<string, CredentialReference>> = {},
): CredentialReferenceStorePort & { remaining(): readonly string[] } {
  const held = new Map(Object.entries(paths));
  const locate = (reference: CredentialReference): string | null => {
    for (const [path, candidate] of held) {
      if (credentialRemovalIdentity(candidate) === credentialRemovalIdentity(reference)) {
        return path;
      }
    }
    return null;
  };

  return {
    remaining: (): readonly string[] => [...held.keys()],
    async removeReference(reference: CredentialReference): Promise<CredentialPartOutcome> {
      const path = locate(reference);
      if (path === null) {
        return { result: "not-present", code: null };
      }
      held.delete(path);
      return { result: "removed", code: null };
    },
  };
}
