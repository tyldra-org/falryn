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
  CredentialResolution,
  CredentialStorePort,
  EnvironmentPort,
  LocalDataPlatform,
  SecretResolverPort,
} from "../domain/index.ts";
import {
  type CredentialWriteResult,
  createEnvironmentCredentialStore,
  createKeychainCredentialStore,
  createSessionEnvironmentCredentialLookup,
  type OperatingSystemSecretsPort,
  type SessionEnvironmentCredentialLookupPort,
  writeKeychainCredential,
} from "../integrations/index.ts";
import {
  type AuthorizedProviderCredential,
  parseAuthorizedProviderCredential,
  providerCredentialEnvironmentAliases,
  providerEnvironmentCredentialReference,
} from "../providers/index.ts";
import { createSecretResolver } from "./credential-resolver.ts";
import type { DiagnosticsCollector } from "./diagnostics-collector.ts";

/** Default environment credential for OpenAI SDK live runs (#710/#752). */
export const DEFAULT_OPENAI_CREDENTIAL_REFERENCE: CredentialReference =
  providerEnvironmentCredentialReference("openai", "openai");

export type ProductCredentialPorts = {
  readonly clock: ClockPort;
  readonly commands: CommandRunnerPort;
  readonly platform: LocalDataPlatform;
  readonly environment: EnvironmentPort;
  readonly secrets?: OperatingSystemSecretsPort;
  /** Injectable null disables post-start environment lookup in isolated tests. */
  readonly sessionEnvironment?: SessionEnvironmentCredentialLookupPort | null;
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

/**
 * Compose the product secret resolver and keychain write channel.
 */
export function composeProductCredentials(ports: ProductCredentialPorts): ProductCredentialBundle {
  const keychain = createKeychainCredentialStore({
    clock: ports.clock,
    platform: ports.platform,
    ...(ports.secrets === undefined ? {} : { secrets: ports.secrets }),
  });
  const sessionEnvironment =
    ports.sessionEnvironment === undefined
      ? createSessionEnvironmentCredentialLookup({
          commands: ports.commands,
          environment: ports.environment,
          platform: ports.platform,
        })
      : ports.sessionEnvironment;
  const environment = createEnvironmentCredentialStore({
    environment: ports.environment,
    clock: ports.clock,
    aliases: providerCredentialEnvironmentAliases(),
    session: sessionEnvironment,
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
      // Never log or return the secret. Bun passes it directly to the current
      // user's operating-system vault rather than argv or environment.
      return writeKeychainCredential({
        platform: ports.platform,
        reference: input.reference,
        secret: input.secret,
        ...(ports.secrets === undefined ? {} : { secrets: ports.secrets }),
      });
    },
    async placeAuthorizedCredential(input) {
      return writeKeychainCredential({
        platform: ports.platform,
        reference: input.reference,
        secret: JSON.stringify(input.credential),
        ...(ports.secrets === undefined ? {} : { secrets: ports.secrets }),
        ...(input.signal === undefined ? {} : { request: { signal: input.signal } }),
      });
    },
    async withAuthorizedCredential(reference, use, signal) {
      const resolution = await resolver.resolve(
        { reference, consumer: reference.consumer },
        async (secret) => {
          const credential = decodeAuthorizedCredential(secret);
          if (credential === null) {
            return { kind: "invalid" as const };
          }
          return { kind: "used" as const, value: await use(credential) };
        },
        signal === undefined ? undefined : { signal },
      );
      if (resolution.kind === "unresolved") {
        return resolution;
      }
      return resolution.value.kind === "invalid"
        ? { kind: "invalid", code: "authorized-credential-invalid" }
        : { kind: "resolved", value: resolution.value.value, health: resolution.health };
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

function decodeAuthorizedCredential(secret: string): AuthorizedProviderCredential | null {
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
