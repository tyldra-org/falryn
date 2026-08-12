/**
 * The provider adapter port.
 *
 * Leaf SDKs implement this interface inside `src/providers/` adapters. Domain,
 * application, CLI, and OpenTUI code consume only this port and the normalized
 * types — never vendor request or stream objects.
 */

import type { ModelId, ProviderId } from "../domain/identity.ts";
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
   * Models this adapter claims to support. Discovery refresh belongs to a
   * later issue; a static list is enough for boundary tests.
   */
  readonly supportedModels: readonly ModelId[];
  stream(
    request: ModelRequest,
    options: ProviderStreamOptions,
  ): AsyncIterable<NormalizedProviderEvent>;
};
