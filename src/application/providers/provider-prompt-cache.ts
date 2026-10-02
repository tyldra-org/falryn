/** Stable, secret-safe provider prompt-cache identities. */

import { createHash } from "node:crypto";

import type { ConfigurationGeneration, SessionId } from "../../domain/foundation/index.ts";
import {
  type ModelMessage,
  type ModelToolDefinition,
  PROMPT_CACHE_POLICY_SCHEMA_VERSION,
  type PromptCachePolicy,
  type PromptCacheSeed,
  type RoutingReceipt,
} from "../../providers/index.ts";

export type ProviderPromptCacheInput = {
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly receipt: RoutingReceipt;
  readonly seed: PromptCacheSeed;
};

function sha256(value: string): string {
  return `sha-256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Preserve the prefix; partition only when the qualified provider contract requires it. */
export function processingPromptCache(
  policy: PromptCachePolicy | undefined,
  partition: "provider-default" | "standard" | "fast" | null,
): PromptCachePolicy | undefined {
  return policy === undefined || partition === null
    ? policy
    : { ...policy, key: sha256(JSON.stringify([policy.key, partition])) };
}

export function promptCacheStablePrefixDigest(
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDefinition[],
): string {
  return sha256(JSON.stringify({ schemaVersion: 1, messages, tools }));
}

/**
 * Rebind a policy to a tool set widened inside the attempt (#947). A cached
 * prefix holds the tools it was created with, so a widened set needs its own
 * key; reusing the old one could serve a prefix without the added tools.
 */
export function promptCacheForWidenedTools(
  policy: PromptCachePolicy | undefined,
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDefinition[],
  added: number,
): PromptCachePolicy | undefined {
  if (policy === undefined || added === 0) return policy;
  const stablePrefixDigest = promptCacheStablePrefixDigest(
    messages.slice(0, policy.stableMessageCount),
    tools,
  );
  return {
    ...policy,
    key: sha256(JSON.stringify([policy.key, stablePrefixDigest])),
    stablePrefixDigest,
  };
}

/**
 * Route and generation changes deliberately produce another key. Retries and
 * tool continuations on the same bound route retain it.
 */
export function providerPromptCachePolicy(input: ProviderPromptCacheInput): PromptCachePolicy {
  if (input.receipt.promptCacheMode === null || input.receipt.promptCacheMode === undefined) {
    throw new Error("A provider prompt-cache policy requires a routed cache mechanism.");
  }
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
    mode: input.receipt.promptCacheMode,
    minimumInputTokens: input.receipt.promptCacheMinimumInputTokens ?? null,
  };
}
