/** Exact provider-bound identity for one executable model route. */

import { type ModelId, modelId, type ProviderId, providerId } from "../domain/identity.ts";
import type { ProviderProfileId } from "./profile.ts";

const MODEL_IDENTITY_KEY_VERSION = 1;
const MAX_IDENTITY_PART_LENGTH = 4_096;

export type ProviderModelIdentity = {
  readonly providerProfileId: ProviderProfileId;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
};

export type ProviderModelIdentityKeyParseResult =
  | { readonly ok: true; readonly value: ProviderModelIdentity }
  | {
      readonly ok: false;
      readonly code: "model-identity-key-invalid";
      readonly message: string;
    };

function validPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTITY_PART_LENGTH;
}

/**
 * Stable, reversible key used by route recursion guards and string-only UI controls.
 * JSON tuple encoding preserves arbitrary provider model IDs without delimiter ambiguity.
 */
export function providerModelIdentityKey(identity: ProviderModelIdentity): string {
  return JSON.stringify([
    MODEL_IDENTITY_KEY_VERSION,
    identity.providerProfileId,
    identity.providerId,
    identity.modelId,
  ]);
}

export function parseProviderModelIdentityKey(input: string): ProviderModelIdentityKeyParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    return {
      ok: false,
      code: "model-identity-key-invalid",
      message: "the model selection identity is malformed",
    };
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    decoded[0] !== MODEL_IDENTITY_KEY_VERSION ||
    !validPart(decoded[1]) ||
    !validPart(decoded[2]) ||
    !validPart(decoded[3])
  ) {
    return {
      ok: false,
      code: "model-identity-key-invalid",
      message: "the model selection identity is unsupported or incomplete",
    };
  }
  return {
    ok: true,
    value: {
      providerProfileId: decoded[1],
      providerId: providerId.from(decoded[2]),
      modelId: modelId.from(decoded[3]),
    },
  };
}

export function sameProviderModelIdentity(
  left: ProviderModelIdentity | null,
  right: ProviderModelIdentity | null,
): boolean {
  return (
    left?.providerProfileId === right?.providerProfileId &&
    left?.providerId === right?.providerId &&
    left?.modelId === right?.modelId
  );
}
