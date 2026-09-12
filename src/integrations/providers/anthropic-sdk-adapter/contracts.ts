import type { ClientOptions } from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
  RedactedThinkingBlockParam,
  ServerToolUseBlockParam,
  ThinkingBlockParam,
  ToolSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";

import type {
  AnthropicMessagesTransportCompatibilityDeclaration,
  ProviderModelTransportCompatibilityOverride,
} from "../../../providers/configuration/transport-compatibility.ts";
import type { ProviderContinuationStatePort } from "../../../providers/protocol/continuation-state.ts";

export type AnthropicSdkFetch = NonNullable<ClientOptions["fetch"]>;

export type AnthropicSdkStreamFactory = (
  apiKey: string,
  body: MessageCreateParamsStreaming,
  signal: AbortSignal,
) => Promise<AsyncIterable<RawMessageStreamEvent>>;

export type AnthropicSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly baseUrl?: string | null;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly fetch?: AnthropicSdkFetch;
  readonly supportedModels: readonly string[];
  readonly requestTimeoutMs?: number;
  /** Deterministic SDK boundary used by tests. Production leaves this absent. */
  readonly createStream?: AnthropicSdkStreamFactory;
  readonly compatibility?: AnthropicMessagesTransportCompatibilityDeclaration;
  readonly modelCompatibility?: readonly ProviderModelTransportCompatibilityOverride[];
  readonly continuationState?: ProviderContinuationStatePort;
  /** Injectable for deterministic persistence fixtures. */
  readonly now?: () => number;
};

type ToolCallState = {
  readonly id: string;
  readonly name: string;
  arguments: string;
  proposed: boolean;
  stopped: boolean;
};

export type RetainedThinkingBlock = ThinkingBlockParam | RedactedThinkingBlockParam;

export type RetainedContinuation = {
  readonly thinking: readonly RetainedThinkingBlock[];
  readonly search?: readonly (ServerToolUseBlockParam | ToolSearchToolResultBlockParam)[];
};

export type ContentBlockState =
  | { readonly type: "text"; stopped: boolean }
  | { readonly type: "thinking"; thinking: string; signature: string; stopped: boolean }
  | { readonly type: "redacted-thinking"; readonly data: string; stopped: boolean }
  | {
      readonly type: "server-tool";
      readonly name: string;
      stopped: boolean;
      retained?: ServerToolUseBlockParam;
      arguments?: string;
    }
  | ({ readonly type: "tool" } & ToolCallState);
