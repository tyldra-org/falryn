/**
 * Durable, provider-opaque continuation state.
 *
 * SDK adapters own the payload schema. The data layer only binds bytes to an
 * exact profile, destination, model, transport plan, and provider call ID so a
 * restarted adapter cannot replay state through a different route.
 */

import type { ModelId, ProviderId } from "../domain/identity.ts";
import type { Result } from "../domain/result.ts";

export const PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION = 1;

export type ProviderContinuationStateKey = {
  readonly profileId: string;
  readonly providerId: ProviderId;
  readonly destinationId: string;
  readonly transportCompatibilityId: string;
  readonly modelId: ModelId;
  readonly toolCallId: string;
};

export type ProviderContinuationStateRecord = ProviderContinuationStateKey & {
  readonly schemaVersion: typeof PROVIDER_CONTINUATION_STATE_SCHEMA_VERSION;
  /** Adapter-owned JSON. Never projected into prompts, events, or diagnostics. */
  readonly stateJson: string;
  readonly capturedAt: number;
};

export type ProviderContinuationStateError = {
  readonly code: "unavailable" | "malformed" | "conflict";
};

export type ProviderContinuationStatePort = {
  load(
    key: ProviderContinuationStateKey,
  ): Result<ProviderContinuationStateRecord | null, ProviderContinuationStateError>;
  save(
    records: readonly ProviderContinuationStateRecord[],
  ): Result<
    { readonly inserted: number; readonly replaced: number },
    ProviderContinuationStateError
  >;
};
