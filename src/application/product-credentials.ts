/**
 * Product credential bootstrap (#710).
 *
 * Composes the secret resolver over the approved store adapters (environment +
 * operating-system keychain) and offers an interactive API-key placement path
 * that never prints the secret. Live provider attempts resolve through this
 * graph rather than reading process env ad hoc.
 */

import type {
  ClockPort,
  CommandRunnerPort,
  CredentialReference,
  CredentialStorePort,
  EnvironmentPort,
  LocalDataPlatform,
  SecretResolverPort,
} from "../domain/index.ts";
import {
  type CredentialWriteResult,
  createEnvironmentCredentialStore,
  createKeychainCredentialStore,
  writeKeychainCredential,
} from "../integrations/index.ts";
import { createSecretResolver } from "./credential-resolver.ts";
import type { DiagnosticsCollector } from "./diagnostics-collector.ts";

/** Default environment credential for OpenAI-compatible live runs (#710/#752). */
export const DEFAULT_OPENAI_CREDENTIAL_REFERENCE: CredentialReference = {
  storeKind: "environment",
  locator: "FALRYN_OPENAI_API_KEY",
  consumer: "provider:openai",
  accountLabel: null,
};

export type ProductCredentialPorts = {
  readonly clock: ClockPort;
  readonly commands: CommandRunnerPort;
  readonly platform: LocalDataPlatform;
  readonly environment: EnvironmentPort;
  readonly diagnostics?: DiagnosticsCollector;
};

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
};

/**
 * Compose the product secret resolver and keychain write channel.
 */
export function composeProductCredentials(ports: ProductCredentialPorts): ProductCredentialBundle {
  const keychain = createKeychainCredentialStore({
    commands: ports.commands,
    clock: ports.clock,
    platform: ports.platform,
  });
  const environment = createEnvironmentCredentialStore({
    environment: ports.environment,
    clock: ports.clock,
  });
  const stores = [keychain, environment] as const;
  const resolver = createSecretResolver({
    stores,
    clock: ports.clock,
    ...(ports.diagnostics === undefined ? {} : { diagnostics: ports.diagnostics }),
  });

  return {
    resolver,
    stores,
    async placeApiKey(input) {
      // Never log or return the secret; writeKeychainCredential passes it only
      // through the supervised process stdin channel.
      return writeKeychainCredential({
        commands: ports.commands,
        platform: ports.platform,
        reference: input.reference,
        secret: input.secret,
      });
    },
  };
}

/**
 * Resolve a provider bearer token through the product resolver.
 * Fail closed: missing/unresolved credentials yield null (no bypass).
 */
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
  const value = resolution.value.trim();
  return value.length === 0 ? null : value;
}
