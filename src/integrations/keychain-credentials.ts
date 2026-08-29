/**
 * Cross-platform operating-system credential storage through Bun's native
 * secrets API.
 *
 * Bun maps this one narrow API onto macOS Keychain Services, Linux Secret
 * Service, and Windows Credential Manager. Falryn does not enumerate stores,
 * expose this adapter as a tool, or pass credential values through argv,
 * environment variables, diagnostics, or durable state.
 */

import {
  addDuration,
  type ClockPort,
  type CredentialPartOutcome,
  type CredentialReference,
  type CredentialRequestOptions,
  type CredentialResolution,
  type CredentialStoreAvailability,
  type CredentialStorePort,
  type CredentialUnresolvedStatus,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  type DurationMs,
  healthForStatus,
  type LocalDataPlatform,
  MAX_CREDENTIAL_SECRET_BYTES,
  type SecretUse,
} from "../domain/index.ts";

const STORE_KIND = "operating-system-keychain" as const;

/** Narrow injectable boundary around `Bun.secrets`. */
export type OperatingSystemSecretsPort = {
  get(options: { readonly service: string; readonly name: string }): Promise<string | null>;
  set(options: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
    readonly allowUnrestrictedAccess?: boolean;
  }): Promise<void>;
  delete(options: { readonly service: string; readonly name: string }): Promise<boolean>;
};

const LEGAL_IDENTIFIER = /^[^\p{Cc}]{1,255}$/u;

const RETRYABLE_STATUSES: ReadonlySet<CredentialUnresolvedStatus> = new Set([
  "locked",
  "denied",
  "unavailable",
  "timed-out",
  "cancelled",
]);

export type KeychainCredentialStoreOptions = {
  readonly clock: ClockPort;
  readonly platform: LocalDataPlatform;
  readonly secrets?: OperatingSystemSecretsPort;
  readonly timeoutMs?: DurationMs;
};

type OperationOutcome<Value> =
  | { readonly kind: "completed"; readonly value: Value }
  | { readonly kind: "timed-out" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed" };

function credentialName(reference: CredentialReference): string {
  return reference.accountLabel ?? reference.consumer;
}

function validReference(reference: CredentialReference): boolean {
  return (
    LEGAL_IDENTIFIER.test(reference.locator) && LEGAL_IDENTIFIER.test(credentialName(reference))
  );
}

async function settle<Value>(input: {
  readonly operation: Promise<Value>;
  readonly clock: ClockPort;
  readonly timeoutMs: DurationMs;
  readonly signal?: AbortSignal;
}): Promise<OperationOutcome<Value>> {
  if (input.signal?.aborted === true) {
    return { kind: "cancelled" };
  }
  const deadlineController = new AbortController();
  const onAbort = (): void => deadlineController.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const operation = input.operation.then(
    (value): OperationOutcome<Value> => ({ kind: "completed", value }),
    (): OperationOutcome<Value> => ({ kind: "failed" }),
  );
  const deadline = input.clock
    .waitUntil(addDuration(input.clock.now(), input.timeoutMs), deadlineController.signal)
    .then(
      (outcome): OperationOutcome<Value> =>
        outcome === "aborted" ? { kind: "cancelled" } : { kind: "timed-out" },
    );
  try {
    const outcome = await Promise.race([operation, deadline]);
    if (outcome.kind === "completed" || outcome.kind === "failed") {
      deadlineController.abort();
    }
    return outcome;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function unresolvedStatus(
  outcome: Exclude<OperationOutcome<unknown>, { readonly kind: "completed" }>,
): CredentialUnresolvedStatus {
  switch (outcome.kind) {
    case "cancelled":
      return "cancelled";
    case "timed-out":
      return "timed-out";
    case "failed":
      return "unavailable";
  }
}

export function createKeychainCredentialStore(
  options: KeychainCredentialStoreOptions,
): CredentialStorePort {
  const secrets = options.secrets ?? Bun.secrets;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS;
  const availability: CredentialStoreAvailability = { kind: "available" };

  const unresolved = (
    status: CredentialUnresolvedStatus,
    code: string,
    consumer: string,
  ): CredentialResolution<never> => ({
    kind: "unresolved",
    failure: {
      status,
      code,
      retryable: RETRYABLE_STATUSES.has(status),
      storeKind: STORE_KIND,
      consumer,
      health: healthForStatus(status, STORE_KIND, options.clock.now()),
    },
  });

  return {
    storeKind: STORE_KIND,

    availability: (): CredentialStoreAvailability => availability,

    async read<Value>(
      reference: CredentialReference,
      use: SecretUse<Value>,
      request?: CredentialRequestOptions,
    ): Promise<CredentialResolution<Value>> {
      if (request?.signal?.aborted === true) {
        return unresolved("cancelled", "aborted-before-read", reference.consumer);
      }
      if (!validReference(reference)) {
        return unresolved("malformed", "illegal-credential-identifier", reference.consumer);
      }

      const outcome = await settle({
        operation: secrets.get({ service: reference.locator, name: credentialName(reference) }),
        clock: options.clock,
        timeoutMs: request?.timeoutMs ?? timeoutMs,
        ...(request?.signal === undefined ? {} : { signal: request.signal }),
      });
      if (outcome.kind !== "completed") {
        const status = unresolvedStatus(outcome);
        return unresolved(status, `secrets-${outcome.kind}`, reference.consumer);
      }
      if (outcome.value === null) {
        return unresolved("missing", "entry-missing", reference.consumer);
      }
      if (outcome.value.length === 0) {
        return unresolved("empty", "empty-entry", reference.consumer);
      }
      if (Buffer.byteLength(outcome.value, "utf8") > MAX_CREDENTIAL_SECRET_BYTES) {
        return unresolved("malformed", "secret-too-large", reference.consumer);
      }

      return {
        kind: "resolved",
        value: await use(outcome.value),
        health: { state: "present", storeKind: STORE_KIND, observedAt: options.clock.now() },
      };
    },

    async removeSecret(
      reference: CredentialReference,
      request?: CredentialRequestOptions,
    ): Promise<CredentialPartOutcome> {
      if (request?.signal?.aborted === true) {
        return { result: "failed", code: "aborted-before-delete" };
      }
      if (!validReference(reference)) {
        return { result: "failed", code: "illegal-credential-identifier" };
      }
      const outcome = await settle({
        operation: secrets.delete({ service: reference.locator, name: credentialName(reference) }),
        clock: options.clock,
        timeoutMs: request?.timeoutMs ?? timeoutMs,
        ...(request?.signal === undefined ? {} : { signal: request.signal }),
      });
      if (outcome.kind !== "completed") {
        return { result: "failed", code: `secrets-${outcome.kind}` };
      }
      return outcome.value
        ? { result: "removed", code: null }
        : { result: "not-present", code: null };
    },
  };
}
