/**
 * The provider adapter port.
 *
 * Leaf SDKs implement this interface inside `src/providers/` adapters. Domain,
 * application, CLI, and OpenTUI code consume only this port and the normalized
 * types — never vendor request or stream objects.
 */

import type { ModelId, ProviderId } from "../domain/identity.ts";
import type { ModelCapability } from "./model-capability.ts";
import type { ModelRequest } from "./request.ts";
import type { NormalizedProviderEvent } from "./stream.ts";

export type ProviderAdapterIdentity = {
  readonly providerId: ProviderId;
  /** Configuration profile key; opaque to callers outside config. */
  readonly profileId: string;
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
  /** Optional adapter-owned facts used when no product catalog was supplied. */
  readonly modelCapabilities?: readonly ModelCapability[] | undefined;
  stream(
    request: ModelRequest,
    options: ProviderStreamOptions,
  ): AsyncIterable<NormalizedProviderEvent>;
};
