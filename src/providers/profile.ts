/**
 * Immutable provider profile: configuration-generation values for one destination.
 *
 * Profiles name adapter kind, endpoint, credential reference, timeouts, enabled
 * models, and discovery policy. Secret bytes never appear here — only a
 * {@link CredentialReference}.
 */

import type { CredentialReference } from "../domain/configuration.ts";
import type { ModelId, ProviderId } from "../domain/identity.ts";
import type { DiscoveryPolicy, ProviderAdapterKind } from "./adapter-kind.ts";
import type { ModelCatalogId } from "./catalog/contracts.ts";
import type { ModelCapabilityDeclaration } from "./model-capability.ts";
import type { ProviderTransportCompatibilityDeclaration } from "./transport-compatibility.ts";

export type ProviderProfileId = string;

export type ProviderNetworkTimeouts = {
  readonly connectMs: number;
  readonly requestMs: number;
};

export type ProviderProfile = {
  readonly profileId: ProviderProfileId;
  readonly providerId: ProviderId;
  readonly adapterKind: ProviderAdapterKind;
  readonly displayName: string;
  /**
   * Data destination. Custom endpoints used through the OpenAI SDK are separate
   * destinations even when JSON looks similar.
   */
  readonly endpoint: string | null;
  readonly credential: CredentialReference | null;
  readonly organization: string | null;
  readonly project: string | null;
  readonly enabledModels: readonly ModelId[];
  /** User-owned catalog documents loaded from ~/.falryn/catalogs by identity. */
  readonly catalogs?: readonly ModelCatalogId[];
  /** Explicit facts for enabled models. An empty list leaves every fact unknown. */
  readonly modelCapabilities: readonly ModelCapabilityDeclaration[];
  /** Optional destination-bound wire overrides; omitted profiles use the exact adapter baseline. */
  readonly transportCompatibility: ProviderTransportCompatibilityDeclaration | null;
  readonly discovery: DiscoveryPolicy;
  readonly timeouts: ProviderNetworkTimeouts;
};

/** Consumer string used when a profile has no credential reference yet. */
export function profileCredentialConsumer(profile: ProviderProfile): string {
  return profile.credential?.consumer ?? `provider:${profile.profileId}`;
}
