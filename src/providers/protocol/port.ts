/**
 * The provider adapter port.
 *
 * Leaf SDKs implement this interface inside `src/providers/` adapters. Domain,
 * application, CLI, and OpenTUI code consume only this port and the normalized
 * types — never vendor request or stream objects.
 */

import type { ModelId, ProviderId } from "../../domain/foundation/identity.ts";
import type {
  ModelCapability,
  ModelInputModality,
  ModelResponseDensityControl,
} from "../catalog/model-capability.ts";
import type { ProviderAdapterKind } from "../configuration/adapter-kind.ts";
import type { ProviderTransportCompatibilityPlan } from "../configuration/transport-compatibility.ts";
import type { ModelRequest } from "./request.ts";
import type { NormalizedProviderEvent } from "./stream.ts";

export type ProviderAdapterIdentity = {
  readonly providerId: ProviderId;
  /** Configuration profile key; opaque to callers outside config. */
  readonly profileId: string;
  readonly adapterKind: ProviderAdapterKind;
  /** Exact configured destination; null means the adapter's official default. */
  readonly endpoint: string | null;
  /** Secret-safe equality identity for adapter kind plus configured endpoint. */
  readonly destinationId: string;
  /** Immutable identity of the exact request/response translation behavior. */
  readonly transportCompatibilityId?: string | undefined;
  readonly displayName: string;
};

export type ProviderStreamOptions = {
  readonly signal: AbortSignal;
};

/**
 * A provider adapter streams normalized events for one immutable request.
 *
 * Cancellation cooperates with `signal`. After a terminal event the iterator
 * must end; emitting further events is an adapter defect.
 */
export type ProviderAdapterPort = {
  readonly identity: ProviderAdapterIdentity;
  /**
   * Models this adapter can execute. Product sessions normally supply a
   * generation-bound discovery catalog; the list remains the execution guard.
   */
  readonly supportedModels: readonly ModelId[];
  /** Modalities this adapter can preserve in a provider request today. */
  readonly requestInputModalities: readonly ModelInputModality[];
  /** Native response-density values this concrete SDK transport can send. */
  readonly requestResponseDensityControls?: readonly ModelResponseDensityControl[];
  /** Secret-free plan used by this concrete adapter instance. */
  readonly transportCompatibility?: ProviderTransportCompatibilityPlan | undefined;
  /** Exact immutable translation plan for one supported model. */
  transportCompatibilityFor(modelId: ModelId): ProviderTransportCompatibilityPlan | null;
  /** Optional adapter-owned facts used when no product catalog was supplied. */
  readonly modelCapabilities?: readonly ModelCapability[] | undefined;
  stream(
    request: ModelRequest,
    options: ProviderStreamOptions,
  ): AsyncIterable<NormalizedProviderEvent>;
};
