/**
 * The environment-reference credential store.
 *
 * The locator is a canonical variable name. A caller may supply explicit
 * aliases for that locator, but this store never scans the environment for
 * names that look like credentials. A variable becoming a credential merely
 * because its name looks plausible is how an unrelated value ends up in a
 * provider request.
 *
 * It works on every platform, so no host is left without a credential path when
 * the keychain adapter reports `unsupported`.
 */

import {
  type ClockPort,
  type CredentialPartOutcome,
  type CredentialReference,
  type CredentialRequestOptions,
  type CredentialResolution,
  type CredentialStoreAvailability,
  type CredentialStorePort,
  type CredentialUnresolvedStatus,
  type EnvironmentPort,
  healthForStatus,
  MAX_CREDENTIAL_SECRET_BYTES,
  type SecretUse,
} from "../domain/index.ts";

/**
 * A legal environment variable name.
 *
 * Deliberately narrower than what a shell will export: a name outside this
 * shape is rejected as `malformed` rather than looked up, so a locator can
 * never be a sentence, a path, or an option that happens to be readable.
 */
const LEGAL_VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const STORE_KIND = "environment" as const;

export function createEnvironmentCredentialStore(options: {
  readonly environment: EnvironmentPort;
  readonly clock: ClockPort;
  /** Explicit fallbacks keyed by the persisted canonical locator. */
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
}): CredentialStorePort {
  const { environment, clock } = options;

  const variablesFor = (locator: string): readonly string[] => [
    locator,
    ...(options.aliases?.[locator] ?? []),
  ];

  const unresolved = (
    status: CredentialUnresolvedStatus,
    code: string,
    retryable: boolean,
    consumer: string,
  ) => ({
    kind: "unresolved" as const,
    failure: {
      status,
      code,
      retryable,
      storeKind: STORE_KIND,
      consumer,
      health: healthForStatus(status, STORE_KIND, clock.now()),
    },
  });

  return {
    storeKind: STORE_KIND,

    availability: (): CredentialStoreAvailability => ({ kind: "available" }),

    async read<Value>(
      reference: CredentialReference,
      use: SecretUse<Value>,
      requestOptions?: CredentialRequestOptions,
    ): Promise<CredentialResolution<Value>> {
      if (requestOptions?.signal?.aborted === true) {
        return unresolved("cancelled", "aborted-before-read", true, reference.consumer);
      }
      if (!LEGAL_VARIABLE_NAME.test(reference.locator)) {
        return unresolved("malformed", "illegal-variable-name", false, reference.consumer);
      }

      const variables = variablesFor(reference.locator);
      if (variables.some((variable) => !LEGAL_VARIABLE_NAME.test(variable))) {
        return unresolved("malformed", "illegal-variable-alias", false, reference.consumer);
      }
      const value = variables
        .map((variable) => environment.get(variable))
        .find((candidate): candidate is string => candidate !== null);
      if (value === undefined) {
        // The port reports an exported-but-empty variable as unset, so `missing`
        // and `empty` cannot be distinguished here. Reporting the one that is
        // certainly true is better than inventing the one that might be.
        return unresolved("missing", "variable-unset", false, reference.consumer);
      }
      // Byte length, not code-unit length: the bound is declared in bytes, and
      // a multibyte secret would otherwise pass a check it exceeds.
      if (Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_SECRET_BYTES) {
        return unresolved("malformed", "secret-too-large", false, reference.consumer);
      }

      return {
        kind: "resolved",
        value: await use(value),
        health: { state: "present", storeKind: STORE_KIND, observedAt: clock.now() },
      };
    },

    /**
     * There is nothing here to delete.
     *
     * A process cannot unset a variable in the shell that exported it, and
     * clearing it in this process would change nothing durable while looking
     * like it had. Reporting `unsupported` is what makes removing an
     * environment-backed credential a visibly partial outcome rather than a
     * success that left the secret in place.
     */
    async removeSecret(): Promise<CredentialPartOutcome> {
      return { result: "unsupported", code: "environment-not-writable" };
    },
  };
}
