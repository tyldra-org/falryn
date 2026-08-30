/** Store a provider API key in the current user's operating-system vault. */

import {
  type CredentialReference,
  type CredentialRequestOptions,
  type LocalDataPlatform,
  MAX_CREDENTIAL_SECRET_BYTES,
} from "../domain/index.ts";
import type { OperatingSystemSecretsPort } from "./keychain-credentials.ts";

const LEGAL_IDENTIFIER = /^[^\p{Cc}]{1,255}$/u;

export type CredentialWriteResult =
  | { readonly kind: "written" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "unsupported"; readonly code: string };

export type WriteKeychainCredentialOptions = {
  readonly platform: LocalDataPlatform;
  readonly reference: CredentialReference;
  readonly secret: string;
  readonly secrets?: OperatingSystemSecretsPort;
  readonly request?: CredentialRequestOptions;
};

/** Write or replace the exact service/account pair without exposing its value. */
export async function writeKeychainCredential(
  options: WriteKeychainCredentialOptions,
): Promise<CredentialWriteResult> {
  const name = options.reference.accountLabel ?? options.reference.consumer;
  if (!LEGAL_IDENTIFIER.test(options.reference.locator) || !LEGAL_IDENTIFIER.test(name)) {
    return { kind: "failed", code: "illegal-credential-identifier" };
  }
  if (options.secret.length === 0) {
    return { kind: "failed", code: "empty-secret" };
  }
  if (Buffer.byteLength(options.secret, "utf8") > MAX_CREDENTIAL_SECRET_BYTES) {
    return { kind: "failed", code: "secret-too-large" };
  }
  if (options.request?.signal?.aborted === true) {
    return { kind: "failed", code: "aborted-before-write" };
  }

  try {
    await (options.secrets ?? Bun.secrets).set({
      service: options.reference.locator,
      name,
      value: options.secret,
      // Never weaken the macOS access-control list for unattended access.
      allowUnrestrictedAccess: false,
    });
    return { kind: "written" };
  } catch {
    return { kind: "failed", code: "secrets-write-failed" };
  }
}
