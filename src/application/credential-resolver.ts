/**
 * The one place a reference becomes a secret.
 *
 * The resolver routes a request to the store its reference names, and does four
 * things before it lets a store see anything:
 *
 * - **binds the request to one consumer.** A reference declares who may resolve
 *   it, and a caller declares who is asking. A mismatch is refused before any
 *   store is touched, so "limited to the integration that needs it" is enforced
 *   rather than trusted;
 * - **refuses a store this build has no adapter for**, and a store whose
 *   adapter reports itself unsupported on this host, each with its own status;
 * - **applies a deadline and an abort**, so a keychain that never answers stops
 *   the operation instead of holding it; and
 * - **emits one diagnostic per resolution** carrying the store kind, the
 *   consumer, and the status — and never the locator, the account, the secret,
 *   or how long a comparison against a secret took.
 *
 * The resolved value never passes through this module: `use` runs inside the
 * store, and what comes back is whatever `use` returned. There is no branch
 * here that can see the secret.
 */

import {
  type ClockPort,
  type CorrelationIds,
  type CredentialRequestOptions,
  type CredentialResolution,
  type CredentialStoreKind,
  type CredentialStorePort,
  type CredentialUnresolvedStatus,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  type DurationMs,
  healthForStatus,
  NO_CORRELATION,
  type SecretRequest,
  type SecretResolverPort,
  type SecretUse,
} from "../domain/index.ts";
import type { DiagnosticsCollector } from "./diagnostics-collector.ts";

export type SecretResolverOptions = {
  readonly stores: readonly CredentialStorePort[];
  readonly clock: ClockPort;
  /** Optional: a resolver with no collector still resolves, silently. */
  readonly diagnostics?: DiagnosticsCollector;
  readonly correlation?: CorrelationIds;
  readonly defaultTimeoutMs?: DurationMs;
};

export function createSecretResolver(options: SecretResolverOptions): SecretResolverPort {
  const { clock } = options;
  const correlation = options.correlation ?? NO_CORRELATION;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CREDENTIAL_TIMEOUT_MS;

  const byKind = new Map<CredentialStoreKind, CredentialStorePort>();
  for (const store of options.stores) {
    if (byKind.has(store.storeKind)) {
      // Two adapters for one store kind means two answers to "where is this
      // secret", and the wrong one would be chosen by registration order.
      throw new Error(`duplicate credential store adapter: ${store.storeKind}`);
    }
    byKind.set(store.storeKind, store);
  }

  const record = (
    storeKind: CredentialStoreKind,
    consumer: string,
    status: CredentialUnresolvedStatus | "resolved",
    code: string,
  ): void => {
    options.diagnostics?.emit({
      level: status === "resolved" ? "debug" : "warn",
      subsystem: "credentials",
      code: `credential.${status}`,
      correlation,
      stage: "resolve",
      // Store kind and consumer only. The locator is withheld from every
      // rendering, and a diagnostic is a rendering.
      metadata: { storeKind, consumer, reason: code },
    });
  };

  const refuse = <Value>(
    storeKind: CredentialStoreKind,
    consumer: string,
    status: CredentialUnresolvedStatus,
    code: string,
    retryable: boolean,
  ): CredentialResolution<Value> => {
    record(storeKind, consumer, status, code);
    return {
      kind: "unresolved",
      failure: {
        status,
        code,
        retryable,
        storeKind,
        consumer,
        health: healthForStatus(status, storeKind, clock.now()),
      },
    };
  };

  return {
    async resolve<Value>(
      request: SecretRequest,
      use: SecretUse<Value>,
      requestOptions?: CredentialRequestOptions,
    ): Promise<CredentialResolution<Value>> {
      const { reference } = request;
      const { storeKind } = reference;

      if (request.consumer !== reference.consumer) {
        // Refused before the store is named, let alone reached. A provider
        // asking for another provider's credential learns nothing about
        // whether that credential exists.
        return refuse(storeKind, request.consumer, "denied", "consumer-mismatch", false);
      }

      const store = byKind.get(storeKind);
      if (store === undefined) {
        return refuse(storeKind, request.consumer, "unsupported", "store-not-registered", false);
      }

      const availability = store.availability();
      if (availability.kind === "unsupported") {
        return refuse(
          storeKind,
          request.consumer,
          "unsupported",
          `platform-${availability.platform}`,
          false,
        );
      }

      if (requestOptions?.signal?.aborted === true) {
        return refuse(storeKind, request.consumer, "cancelled", "aborted-before-read", true);
      }

      const resolution = await store.read<Value>(reference, use, {
        timeoutMs: requestOptions?.timeoutMs ?? defaultTimeoutMs,
        signal: requestOptions?.signal,
      });

      if (resolution.kind === "resolved") {
        record(storeKind, request.consumer, "resolved", "read");
        return resolution;
      }
      record(storeKind, request.consumer, resolution.failure.status, resolution.failure.code);
      // The store's failure is returned as it reported it, with the consumer
      // filled in — a store does not know who asked, and the caller does.
      return {
        kind: "unresolved",
        failure: { ...resolution.failure, consumer: request.consumer },
      };
    },
  };
}
