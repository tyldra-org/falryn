/** Provider credential contracts and protected resolution. Host stores are composed by the CLI. */

import type { CredentialReference } from "../../domain/configuration/index.ts";
import type {
  CredentialResolution,
  CredentialStorePort,
  CredentialWriteResult,
  SecretResolverPort,
} from "../../domain/security/index.ts";
import {
  type AuthorizedProviderCredential,
  parseAuthorizedProviderCredential,
  providerEnvironmentCredentialReference,
} from "../../providers/index.ts";

/** Default environment credential for OpenAI SDK live runs (#710/#752). */
export const DEFAULT_OPENAI_CREDENTIAL_REFERENCE: CredentialReference =
  providerEnvironmentCredentialReference("openai", "openai");

export type ProductCredentialBundle = {
  readonly resolver: SecretResolverPort;
  readonly stores: readonly CredentialStorePort[];
  /**
   * Place an API key into the keychain without echoing it. Fails closed on
   * unsupported platforms or empty secrets.
   */
  placeApiKey(input: {
    readonly reference: CredentialReference;
    readonly secret: string;
  }): Promise<CredentialWriteResult>;
  /** Store a versioned OAuth credential bundle without projecting its bytes. */
  placeAuthorizedCredential(input: {
    readonly reference: CredentialReference;
    readonly credential: AuthorizedProviderCredential;
    readonly signal?: AbortSignal;
  }): Promise<CredentialWriteResult>;
  /** Decode an authorized credential only inside the caller's protected callback. */
  withAuthorizedCredential<Value>(
    reference: CredentialReference,
    use: (credential: AuthorizedProviderCredential) => Value | Promise<Value>,
    signal?: AbortSignal,
  ): Promise<ProductAuthorizedCredentialResolution<Value>>;
};

export type ProductAuthorizedCredentialResolution<Value> =
  | CredentialResolution<Value>
  | { readonly kind: "invalid"; readonly code: "authorized-credential-invalid" };

export async function resolveProviderApiKey(
  resolver: SecretResolverPort,
  reference: CredentialReference,
  signal?: AbortSignal,
): Promise<string | null> {
  const resolution = await resolver.resolve(
    { reference, consumer: reference.consumer },
    (secret) => secret,
    signal === undefined ? undefined : { signal },
  );
  if (resolution.kind !== "resolved") {
    return null;
  }
  const authorized = decodeAuthorizedCredential(resolution.value);
  if (isAuthorizedCredentialReference(reference) && authorized === null) {
    return null;
  }
  const value = (authorized?.accessToken ?? resolution.value).trim();
  return value.length === 0 ? null : value;
}

function isAuthorizedCredentialReference(reference: CredentialReference): boolean {
  return (
    reference.storeKind === "operating-system-keychain" &&
    reference.locator.startsWith("falryn.provider-authorized.v1.")
  );
}

export function decodeAuthorizedCredential(secret: string): AuthorizedProviderCredential | null {
  if (!secret.startsWith("{")) {
    return null;
  }
  try {
    const parsed = parseAuthorizedProviderCredential(JSON.parse(secret));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}
