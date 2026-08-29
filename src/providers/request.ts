/**
 * Immutable model request handed to a provider adapter.
 *
 * The request already contains rendered context and Falryn tool schemas.
 * Adapters translate it; they do not fetch more workspace data.
 */

import type { ModelId, ProviderId } from "../domain/identity.ts";
import type { ModelRequestId } from "./identity.ts";
import type {
  ModelBudgets,
  ModelMessage,
  ModelToolDefinition,
  OutputContract,
  RequestMetadata,
} from "./messages.ts";
import type { ReasoningEffort } from "./policy.ts";

export const PROMPT_CACHE_POLICY_SCHEMA_VERSION = 1;

/**
 * Secret-safe prompt-cache identity bound before a provider request starts.
 *
 * The key is a SHA-256 digest, never a raw session, account, credential, or
 * prompt value. `stableMessageCount` identifies the leading message prefix
 * whose bytes contributed to `stablePrefixDigest`.
 */
export type PromptCachePolicy = {
  readonly schemaVersion: typeof PROMPT_CACHE_POLICY_SCHEMA_VERSION;
  readonly key: string;
  readonly scope: "session";
  readonly stablePrefixDigest: string;
  readonly stableMessageCount: number;
  readonly toolCatalogGeneration: number;
};

/** Stable prefix facts supplied before the provider route is selected. */
export type PromptCacheSeed = Pick<
  PromptCachePolicy,
  "stablePrefixDigest" | "stableMessageCount" | "toolCatalogGeneration"
>;

export type ModelRequest = {
  readonly requestId: ModelRequestId;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly output: OutputContract;
  readonly budgets: ModelBudgets;
  /** Falryn's provider-neutral posture for this request. */
  readonly reasoning?: ReasoningEffort | undefined;
  /** Exact provider-native control selected from the bound catalog, when available. */
  readonly reasoningControl?: string | null | undefined;
  readonly promptCache?: PromptCachePolicy | undefined;
  readonly metadata: RequestMetadata;
};
