/**
 * Model capability catalogs and discovery.
 *
 * Static discovery builds a catalog from the profile's enabled models. Remote
 * discovery is an injectable port implemented by official SDK leaf adapters;
 * tests use a deterministic double. Catalogs carry provenance and expiry and
 * never claim that a listed model works for every required capability.
 */

import type { Instant } from "../domain/clock.ts";
import type { ModelId } from "../domain/identity.ts";
import { knownModelCapability } from "./known-model-capability.ts";
import {
  capabilityFromDeclaration,
  MODEL_CAPABILITY_SCHEMA_VERSION,
  MODEL_INPUT_MODALITIES,
  type ModelCapability,
  type ModelCapabilityDeclaration,
  type ModelInputModality,
  unknownModelCapability,
} from "./model-capability.ts";
import { unknownModelPricing } from "./model-pricing.ts";
import type { ProviderProfile } from "./profile.ts";

/** Compatibility alias for consumers that mean model input modality. */
export const MODEL_MODALITIES = MODEL_INPUT_MODALITIES;
export type ModelModality = ModelInputModality;
export type { ModelCapability } from "./model-capability.ts";

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
  | "authentication"
  | "rate-limited"
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
  /** User catalog facts already validated against this profile's destination. */
  readonly catalogCapabilities?: readonly ModelCapabilityDeclaration[];
  readonly defaults?: Partial<
    Omit<
      ModelCapabilityDeclaration,
      "schemaVersion" | "modelId" | "displayName" | "inputModalities" | "outputModalities"
    >
  >;
};

/** Builds a catalog solely from configured enabled models. */
export function createStaticModelDiscovery(
  options: StaticDiscoveryOptions = {},
): ModelDiscoveryPort {
  const generation = options.generation ?? 1;

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
      const declared = new Map(
        profile.modelCapabilities.map((capability) => [String(capability.modelId), capability]),
      );
      const catalog = new Map(
        (options.catalogCapabilities ?? []).map((capability) => [
          String(capability.modelId),
          capability,
        ]),
      );
      const models: ModelCapability[] = profile.enabledModels.map((id) => {
        const declaration = declared.get(String(id));
        if (declaration !== undefined) {
          return capabilityFromDeclaration(declaration);
        }
        const catalogDeclaration = catalog.get(String(id));
        if (catalogDeclaration !== undefined) {
          return capabilityFromDeclaration(catalogDeclaration, { provenance: ["user-catalog"] });
        }
        const known = knownModelCapability(
          profile.adapterKind,
          String(id),
          profile.endpoint,
          String(profile.providerId),
        );
        if (known !== null) {
          return capabilityFromDeclaration(known, { provenance: ["falryn-builtin"] });
        }
        const unknown = unknownModelCapability(id);
        return options.defaults === undefined
          ? unknown
          : {
              ...unknown,
              ...options.defaults,
              schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
              modelId: id,
            };
      });
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

/** One safe catalog for adapters that expose identities without capability facts. */
export function catalogFromAdapterModels(
  models: readonly ModelId[],
  options: {
    readonly generation: number;
    readonly fetchedAt: Instant;
    readonly capabilities?: readonly ModelCapability[] | undefined;
  },
): ModelCatalog {
  const supplied = new Map(
    (options.capabilities ?? []).map((capability) => [String(capability.modelId), capability]),
  );
  return {
    generation: options.generation,
    provenance: "static-config",
    fetchedAt: options.fetchedAt,
    expiresAt: null,
    models: models.map((id) => supplied.get(String(id)) ?? unknownModelCapability(id)),
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
          failure: {
            ...script.failure,
            retryable:
              script.failure.kind === "timed-out" ||
              script.failure.kind === "unavailable" ||
              script.failure.kind === "rate-limited",
          },
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
  const baseline = await ports.staticDiscovery.discover(profile, options);
  if (profile.discovery === "static" || baseline.kind === "failed") {
    return baseline;
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
  const discovered = await remote.discover(profile, options);
  if (discovered.kind === "failed") {
    return discovered;
  }
  return {
    kind: "catalog",
    catalog: mergeCatalogs(baseline.catalog, discovered.catalog),
  };
}

function mergeCatalogs(baseline: ModelCatalog, remote: ModelCatalog): ModelCatalog {
  const remoteById = new Map(
    remote.models.map((capability) => [String(capability.modelId), capability]),
  );
  const merged = baseline.models.map((capability) => {
    const discovered = remoteById.get(String(capability.modelId));
    return discovered === undefined ? capability : mergeCapability(discovered, capability);
  });
  return {
    generation: remote.generation,
    provenance: "remote-discovery",
    fetchedAt: remote.fetchedAt,
    expiresAt: remote.expiresAt,
    models: merged,
  };
}

/** Higher-priority configured facts overlay provider discovery without hiding availability. */
function mergeCapability(remote: ModelCapability, configured: ModelCapability): ModelCapability {
  const feature = (
    configured: ModelCapability["tools"],
    discovered: ModelCapability["tools"],
  ): ModelCapability["tools"] => (configured === "unknown" ? discovered : configured);
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    modelId: configured.modelId,
    displayName: configured.displayName ?? remote.displayName,
    inputModalities:
      configured.inputModalities.length === 0 ? remote.inputModalities : configured.inputModalities,
    outputModalities:
      configured.outputModalities.length === 0
        ? remote.outputModalities
        : configured.outputModalities,
    tools: feature(configured.tools, remote.tools),
    structuredOutput: feature(configured.structuredOutput, remote.structuredOutput),
    streaming: feature(configured.streaming, remote.streaming),
    reasoning: feature(configured.reasoning, remote.reasoning),
    reasoningControls:
      configured.reasoningControls.length === 0
        ? remote.reasoningControls
        : configured.reasoningControls,
    responseDensityControls:
      (configured.responseDensityControls ?? []).length === 0
        ? (remote.responseDensityControls ?? [])
        : (configured.responseDensityControls ?? []),
    contextTokens: configured.contextTokens ?? remote.contextTokens,
    outputTokens: configured.outputTokens ?? remote.outputTokens,
    pricing:
      configured.pricing === undefined || configured.pricing.kind === "unknown"
        ? (remote.pricing ?? unknownModelPricing())
        : configured.pricing,
    completeness:
      configured.completeness === "complete" || remote.completeness === "complete"
        ? "complete"
        : "partial",
    availability: remote.availability,
    provenance: [...new Set([...configured.provenance, ...remote.provenance])],
  };
}
