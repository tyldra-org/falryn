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
  readonly metadata: RequestMetadata;
};
