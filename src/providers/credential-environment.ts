/** Source-verified environment credential names for official providers. */

import type { CredentialReference } from "../domain/index.ts";

export type ProviderCredentialEnvironment = {
  readonly providerId: string;
  /** Falryn-owned locator persisted in a provider profile. */
  readonly canonicalVariable: string;
  /** Ordered lookup: Falryn-specific overrides, then provider-native names. */
  readonly variables: readonly string[];
};

const PROVIDER_CREDENTIAL_ENVIRONMENTS = {
  openai: {
    providerId: "openai",
    canonicalVariable: "FALRYN_OPENAI_API_KEY",
    variables: ["FALRYN_OPENAI_API_KEY", "OPENAI_API_KEY"],
  },
  anthropic: {
    providerId: "anthropic",
    canonicalVariable: "FALRYN_ANTHROPIC_API_KEY",
    variables: ["FALRYN_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  },
  google: {
    providerId: "google",
    canonicalVariable: "FALRYN_GOOGLE_API_KEY",
    variables: [
      "FALRYN_GOOGLE_API_KEY",
      "FALRYN_GEMINI_API_KEY",
      // Google's SDK gives GOOGLE_API_KEY precedence when both native names exist.
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
    ],
  },
  commandcode: {
    providerId: "commandcode",
    canonicalVariable: "FALRYN_COMMANDCODE_API_KEY",
    variables: [
      "FALRYN_COMMANDCODE_API_KEY",
      "FALRYN_COMMAND_CODE_API_KEY",
      "FALRYN_CMD_API_KEY",
      // Command Code documents this name for CLI and CI authentication.
      "COMMAND_CODE_API_KEY",
      // Command Code's Provider API examples use this key name.
      "CMD_API_KEY",
      // Compatibility with the provider name written without a separator.
      "COMMANDCODE_API_KEY",
    ],
  },
} as const satisfies Readonly<Record<string, ProviderCredentialEnvironment>>;

export type OfficialProviderCredentialId = keyof typeof PROVIDER_CREDENTIAL_ENVIRONMENTS;

export function providerCredentialEnvironment(
  provider: string,
): ProviderCredentialEnvironment | null {
  return Object.hasOwn(PROVIDER_CREDENTIAL_ENVIRONMENTS, provider)
    ? PROVIDER_CREDENTIAL_ENVIRONMENTS[provider as OfficialProviderCredentialId]
    : null;
}

/**
 * Alias declarations consumed by the environment store.
 *
 * The store remains provider-neutral and never scans the process environment.
 * Only these source-reviewed names can act as fallbacks for a persisted
 * canonical locator.
 */
export function providerCredentialEnvironmentAliases(): Readonly<
  Record<string, readonly string[]>
> {
  return Object.fromEntries(
    Object.values(PROVIDER_CREDENTIAL_ENVIRONMENTS).map((declaration) => [
      declaration.canonicalVariable,
      declaration.variables.slice(1),
    ]),
  );
}

/** Environment reference for an exact official provider destination. */
export function providerEnvironmentCredentialReference(
  provider: OfficialProviderCredentialId,
  profileId: string,
): CredentialReference;
export function providerEnvironmentCredentialReference(
  provider: string,
  profileId: string,
): CredentialReference | null;
export function providerEnvironmentCredentialReference(
  provider: string,
  profileId: string,
): CredentialReference | null {
  const declaration = providerCredentialEnvironment(provider);
  return declaration === null
    ? null
    : {
        storeKind: "environment",
        locator: declaration.canonicalVariable,
        consumer: `provider:${profileId}`,
        accountLabel: null,
      };
}
