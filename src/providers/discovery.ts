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
      const models: ModelCapability[] = profile.enabledModels.map((id) => {
        const declaration = declared.get(String(id));
        if (declaration !== undefined) {
          return capabilityFromDeclaration(declaration);
        }
        const known = knownModelCapability(profile.adapterKind, String(id), profile.endpoint);
        if (known !== null) {
          return capabilityFromDeclaration(known, { provenance: ["compatibility-default"] });
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
    return discovered === undefined ? capability : mergeCapability(capability, discovered);
  });
  return {
    generation: remote.generation,
    provenance: "remote-discovery",
    fetchedAt: remote.fetchedAt,
    expiresAt: remote.expiresAt,
    models: merged,
  };
}

function mergeCapability(baseline: ModelCapability, remote: ModelCapability): ModelCapability {
  const feature = (
    discovered: ModelCapability["tools"],
    configured: ModelCapability["tools"],
  ): ModelCapability["tools"] => (discovered === "unknown" ? configured : discovered);
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    modelId: baseline.modelId,
    displayName: remote.displayName ?? baseline.displayName,
    inputModalities:
      remote.inputModalities.length === 0 ? baseline.inputModalities : remote.inputModalities,
    outputModalities:
      remote.outputModalities.length === 0 ? baseline.outputModalities : remote.outputModalities,
    tools: feature(remote.tools, baseline.tools),
    structuredOutput: feature(remote.structuredOutput, baseline.structuredOutput),
    streaming: feature(remote.streaming, baseline.streaming),
    reasoning: feature(remote.reasoning, baseline.reasoning),
    reasoningControls:
      remote.reasoningControls.length === 0 ? baseline.reasoningControls : remote.reasoningControls,
    contextTokens: remote.contextTokens ?? baseline.contextTokens,
    outputTokens: remote.outputTokens ?? baseline.outputTokens,
    completeness:
      remote.completeness === "complete" || baseline.completeness === "complete"
        ? "complete"
        : "partial",
    availability: remote.availability,
    provenance: [...new Set([...baseline.provenance, ...remote.provenance])],
  };
}
