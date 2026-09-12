import type { ClientOptions } from "openai";
import type {
  ResponseReasoningItem,
  ResponseToolSearchCall,
  ResponseToolSearchOutputItem,
} from "openai/resources/responses/responses";

import type {
  OpenAiResponsesTransportCompatibilityDeclaration,
  ProviderModelTransportCompatibilityOverride,
} from "../../../providers/configuration/transport-compatibility.ts";
import type { ProviderContinuationStatePort } from "../../../providers/protocol/continuation-state.ts";

export type OpenAiResponsesSdkFetch = NonNullable<ClientOptions["fetch"]>;

export type OpenAiResponsesSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly baseUrl: string;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly fetch?: OpenAiResponsesSdkFetch;
  readonly supportedModels?: readonly string[];
  readonly organization?: string | null;
  readonly project?: string | null;
  readonly requestTimeoutMs?: number;
  readonly compatibility: OpenAiResponsesTransportCompatibilityDeclaration;
  readonly modelCompatibility?: readonly ProviderModelTransportCompatibilityOverride[];
  readonly continuationState?: ProviderContinuationStatePort;
  /** Injectable for deterministic persistence fixtures. */
  readonly now?: () => number;
};

export type ToolCallState = {
  callId: string | null;
  name: string | null;
  arguments: string;
  emittedArguments: string;
  argumentsDone: boolean;
  outputDone: boolean;
  proposed: boolean;
  seenAdded: boolean;
  itemId: string;
};

export type RetainedContinuation = {
  readonly responseId: string;
  readonly reasoning: readonly ResponseReasoningItem[];
  readonly search?: readonly (ResponseToolSearchCall | ResponseToolSearchOutputItem)[];
};
