import { createSecretResolver } from "../../application/authentication/credential-resolver.ts";
import {
  decodeAuthorizedCredential,
  type ProductCredentialBundle,
} from "../../application/authentication/product-credentials.ts";
import type { DiagnosticsCollector } from "../../application/diagnostics/diagnostics-collector.ts";
import type { ClockPort, EnvironmentPort } from "../../domain/foundation/index.ts";
import type { CommandRunnerPort } from "../../domain/process/index.ts";
import type { LocalDataPlatform } from "../../domain/storage/index.ts";
import {
  createEnvironmentCredentialStore,
  createKeychainCredentialStore,
  createSessionEnvironmentCredentialLookup,
  type OperatingSystemSecretsPort,
  type SessionEnvironmentCredentialLookupPort,
  writeKeychainCredential,
} from "../../integrations/index.ts";
import { providerCredentialEnvironmentAliases } from "../../providers/index.ts";

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

/** Compose the product secret resolver and keychain write channel. */
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
