/** Stable, secret-safe provider prompt-cache identities. */

import { createHash } from "node:crypto";

import type { ConfigurationGeneration, SessionId } from "../domain/index.ts";
import {
  type ModelMessage,
  type ModelToolDefinition,
  PROMPT_CACHE_POLICY_SCHEMA_VERSION,
  type PromptCachePolicy,
  type PromptCacheSeed,
  type RoutingReceipt,
} from "../providers/index.ts";

export type ProviderPromptCacheInput = {
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly receipt: RoutingReceipt;
  readonly seed: PromptCacheSeed;
};

function sha256(value: string): string {
  return `sha-256:${createHash("sha256").update(value).digest("hex")}`;
}

export function promptCacheStablePrefixDigest(
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDefinition[],
): string {
  return sha256(JSON.stringify({ schemaVersion: 1, messages, tools }));
}

/**
 * Route and generation changes deliberately produce another key. Retries and
 * tool continuations on the same bound route retain it.
 */
export function providerPromptCachePolicy(input: ProviderPromptCacheInput): PromptCachePolicy {
  const keyMaterial = JSON.stringify({
    schemaVersion: PROMPT_CACHE_POLICY_SCHEMA_VERSION,
    sessionId: String(input.sessionId),
    providerId: String(input.receipt.providerId),
    providerProfileId: input.receipt.providerProfileId,
    providerAdapterKind: input.receipt.providerAdapterKind,
    providerDestinationId: input.receipt.providerDestinationId,
    modelId: String(input.receipt.modelId),
    configurationGeneration: Number(input.configurationGeneration),
    providerCatalogGeneration: input.receipt.catalogGeneration,
    modelCapabilitySchemaVersion: input.receipt.modelCapabilitySchemaVersion,
    toolCatalogGeneration: input.seed.toolCatalogGeneration,
    stablePrefixDigest: input.seed.stablePrefixDigest,
  });
  return {
    schemaVersion: PROMPT_CACHE_POLICY_SCHEMA_VERSION,
    key: sha256(keyMaterial),
    scope: "session",
    stablePrefixDigest: input.seed.stablePrefixDigest,
    stableMessageCount: input.seed.stableMessageCount,
    toolCatalogGeneration: input.seed.toolCatalogGeneration,
  };
}
