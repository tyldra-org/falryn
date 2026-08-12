/**
 * Model capability catalogs and discovery.
 *
 * Static discovery builds a catalog from the profile's enabled models. Remote
 * discovery is an injectable port: production adapters arrive later; tests use
 * a deterministic double. Catalogs carry provenance and expiry and never claim
 * that a listed model works for every required capability.
 */

import type { Instant } from "../domain/clock.ts";
import type { ModelId } from "../domain/identity.ts";
import type { ProviderProfile } from "./profile.ts";

export const MODEL_MODALITIES = ["text", "image", "audio"] as const;

export type ModelModality = (typeof MODEL_MODALITIES)[number];

export type ModelCapability = {
  readonly modelId: ModelId;
  readonly modalities: readonly ModelModality[];
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly reasoning: boolean;
  readonly contextTokens: number | null;
  readonly outputTokens: number | null;
};

export type CatalogProvenance = "static-config" | "remote-discovery";

export type ModelCatalog = {
  /** Monotonic generation; remote refresh publishes a new one. */
  readonly generation: number;
  readonly provenance: CatalogProvenance;
  readonly fetchedAt: Instant | null;
  readonly expiresAt: Instant | null;
  readonly models: readonly ModelCapability[];
};

export type DiscoveryFailureKind =
  | "unsupported-policy"
  | "cancelled"
  | "timed-out"
  | "unavailable"
  | "malformed";

export type DiscoveryOutcome =
  | { readonly kind: "catalog"; readonly catalog: ModelCatalog }
  | {
      readonly kind: "failed";
      readonly failure: {
        readonly kind: DiscoveryFailureKind;
        readonly code: string;
        readonly retryable: boolean;
      };
    };

export type ModelDiscoveryPort = {
  discover(
    profile: ProviderProfile,
    options: { readonly signal: AbortSignal; readonly now: Instant },
  ): Promise<DiscoveryOutcome>;
};

export type StaticDiscoveryOptions = {
  readonly generation?: number;
  readonly defaults?: Partial<Omit<ModelCapability, "modelId">>;
};

/** Builds a catalog solely from configured enabled models. */
export function createStaticModelDiscovery(
  options: StaticDiscoveryOptions = {},
): ModelDiscoveryPort {
  const generation = options.generation ?? 1;
  const defaults = {
    modalities: ["text"] as const satisfies readonly ModelModality[],
    tools: true,
    streaming: true,
    reasoning: false,
    contextTokens: null,
    outputTokens: null,
    ...options.defaults,
  };

  return {
    async discover(profile, discoverOptions): Promise<DiscoveryOutcome> {
      if (discoverOptions.signal.aborted) {
        return {
          kind: "failed",
          failure: { kind: "cancelled", code: "discovery-aborted", retryable: false },
        };
      }
      if (profile.discovery !== "static" && profile.discovery !== "remote") {
        return {
          kind: "failed",
          failure: {
            kind: "unsupported-policy",
            code: "unknown-discovery-policy",
            retryable: false,
          },
        };
      }
      // Static catalog is always available from configuration, even when the
      // profile prefers remote refresh later — remote overlays publish a new
      // generation without erasing this baseline.
      const models: ModelCapability[] = profile.enabledModels.map((id) => ({
        modelId: id,
        modalities: defaults.modalities,
        tools: defaults.tools,
        streaming: defaults.streaming,
        reasoning: defaults.reasoning,
        contextTokens: defaults.contextTokens,
        outputTokens: defaults.outputTokens,
      }));
      return {
        kind: "catalog",
        catalog: {
          generation,
          provenance: "static-config",
          fetchedAt: discoverOptions.now,
          expiresAt: null,
          models,
        },
      };
    },
  };
}

/**
 * Remote discovery double for tests: returns a fixed catalog or a scripted failure.
 * Never opens a network socket.
 */
export function createDeterministicRemoteDiscovery(script: {
  readonly catalog?: ModelCatalog;
  readonly failure?: { readonly kind: DiscoveryFailureKind; readonly code: string };
}): ModelDiscoveryPort {
  return {
    async discover(profile, options): Promise<DiscoveryOutcome> {
      if (options.signal.aborted) {
        return {
          kind: "failed",
          failure: { kind: "cancelled", code: "discovery-aborted", retryable: false },
        };
      }
      if (profile.discovery !== "remote") {
        return {
          kind: "failed",
          failure: {
            kind: "unsupported-policy",
            code: "profile-not-remote",
            retryable: false,
          },
        };
      }
      if (script.failure !== undefined) {
        return {
          kind: "failed",
          failure: { ...script.failure, retryable: script.failure.kind !== "malformed" },
        };
      }
      if (script.catalog === undefined) {
        return {
          kind: "failed",
          failure: { kind: "unavailable", code: "no-remote-catalog", retryable: true },
        };
      }
      return { kind: "catalog", catalog: script.catalog };
    },
  };
}

export async function discoverModelCatalog(
  profile: ProviderProfile,
  ports: {
    readonly staticDiscovery: ModelDiscoveryPort;
    readonly remoteDiscovery?: ModelDiscoveryPort | undefined;
  },
  options: { readonly signal: AbortSignal; readonly now: Instant },
): Promise<DiscoveryOutcome> {
  if (profile.discovery === "static") {
    return ports.staticDiscovery.discover(profile, options);
  }
  const remote = ports.remoteDiscovery;
  if (remote === undefined) {
    return {
      kind: "failed",
      failure: {
        kind: "unsupported-policy",
        code: "remote-discovery-unconfigured",
        retryable: false,
      },
    };
  }
  return remote.discover(profile, options);
}
