/**
 * Place a provider API key into the operating-system keychain (#709).
 *
 * Approved write channel: supervised `/usr/bin/security add-generic-password`
 * with an empty child environment. Never logs the secret. Unsupported platforms
 * report `unsupported` rather than inventing a store.
 */

import {
  type CommandRunnerPort,
  type CredentialReference,
  type CredentialRequestOptions,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  type DurationMs,
  type LocalDataPlatform,
  MAX_COMMAND_OUTPUT_BYTES,
} from "../domain/index.ts";
import { SECURITY_EXECUTABLE } from "./keychain-credentials.ts";

const LEGAL_LOCATOR = /^[^\p{Cc}-][^\p{Cc}]{0,255}$/u;

export type CredentialWriteResult =
  | { readonly kind: "written" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "unsupported"; readonly code: string };

export type WriteKeychainCredentialOptions = {
  readonly commands: CommandRunnerPort;
  readonly platform: LocalDataPlatform;
  readonly reference: CredentialReference;
  readonly secret: string;
  readonly timeoutMs?: DurationMs;
  readonly request?: CredentialRequestOptions;
};

/**
 * Write (or update with `-U`) a generic password for the given reference.
 */
export async function writeKeychainCredential(
  options: WriteKeychainCredentialOptions,
): Promise<CredentialWriteResult> {
  if (options.platform !== "darwin") {
    return {
      kind: "unsupported",
      code: `platform-${options.platform}`,
    };
  }
  if (!LEGAL_LOCATOR.test(options.reference.locator)) {
    return { kind: "failed", code: "illegal-locator" };
  }
  if (options.secret.length === 0) {
    return { kind: "failed", code: "empty-secret" };
  }
  if (options.request?.signal?.aborted === true) {
    return { kind: "failed", code: "aborted-before-spawn" };
  }

  const argv: string[] = ["add-generic-password", "-U"];
  if (options.reference.accountLabel !== null) {
    argv.push("-a", options.reference.accountLabel);
  }
  argv.push("-s", options.reference.locator, "-w", options.secret);

  const outcome = await options.commands.run({
    executable: SECURITY_EXECUTABLE,
    argv,
    environment: {},
    timeoutMs: options.request?.timeoutMs ?? options.timeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS,
    maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    signal: options.request?.signal,
  });

  if (outcome.kind !== "exited") {
    return { kind: "failed", code: `spawn-${outcome.kind}` };
  }
  if (outcome.exitCode === 0) {
    return { kind: "written" };
  }
  return { kind: "failed", code: `keychain-exit-${outcome.exitCode}` };
}
