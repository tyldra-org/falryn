/** Versioned provider wire-compatibility declarations and immutable plans. */

import type { ModelId } from "../domain/identity.ts";
import type { ProviderAdapterKind } from "./adapter-kind.ts";

export const PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION = 1;

export const PROVIDER_TRANSPORT_DIALECTS = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generate-content",
  "command-code-router",
  "deterministic",
  "custom-unavailable",
] as const;

export type ProviderTransportDialect = (typeof PROVIDER_TRANSPORT_DIALECTS)[number];

export const OPENAI_SYSTEM_MESSAGE_ROLES = ["system", "developer"] as const;
export type OpenAiSystemMessageRole = (typeof OPENAI_SYSTEM_MESSAGE_ROLES)[number];

export const OPENAI_MAX_OUTPUT_TOKEN_FIELDS = ["max_completion_tokens", "max_tokens"] as const;
export type OpenAiMaxOutputTokenField = (typeof OPENAI_MAX_OUTPUT_TOKEN_FIELDS)[number];

export const OPENAI_STREAMING_USAGE_MODES = ["include", "omit"] as const;
export type OpenAiStreamingUsageMode = (typeof OPENAI_STREAMING_USAGE_MODES)[number];

export const OPENAI_FINISH_REASON_MODES = ["required", "infer"] as const;
export type OpenAiFinishReasonMode = (typeof OPENAI_FINISH_REASON_MODES)[number];

export const OPENAI_TOOL_RESULT_NAME_MODES = ["omit", "required"] as const;
export type OpenAiToolResultNameMode = (typeof OPENAI_TOOL_RESULT_NAME_MODES)[number];

export const OPENAI_ASSISTANT_AFTER_TOOL_RESULT_MODES = ["none", "empty-assistant"] as const;
export type OpenAiAssistantAfterToolResultMode =
  (typeof OPENAI_ASSISTANT_AFTER_TOOL_RESULT_MODES)[number];

export type OpenAiChatTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "openai-chat-completions";
  readonly systemMessageRole: OpenAiSystemMessageRole;
  readonly maxOutputTokensField: OpenAiMaxOutputTokenField;
  readonly streamingUsage: OpenAiStreamingUsageMode;
  readonly finishReason: OpenAiFinishReasonMode;
  readonly strictToolSchemas: boolean;
  readonly toolResultName: OpenAiToolResultNameMode;
  readonly assistantAfterToolResult: OpenAiAssistantAfterToolResultMode;
};

export const OPENAI_RESPONSES_CONTINUATION_MODES = ["stateless", "previous-response"] as const;
export type OpenAiResponsesContinuationMode = (typeof OPENAI_RESPONSES_CONTINUATION_MODES)[number];

export const OPENAI_RESPONSES_REASONING_SUMMARIES = [
  "none",
  "auto",
  "concise",
  "detailed",
] as const;
export type OpenAiResponsesReasoningSummary = (typeof OPENAI_RESPONSES_REASONING_SUMMARIES)[number];

export const OPENAI_RESPONSES_PROMPT_CACHE_TTLS = ["provider-default", "30m"] as const;
export type OpenAiResponsesPromptCacheTtl = (typeof OPENAI_RESPONSES_PROMPT_CACHE_TTLS)[number];

export const OPENAI_RESPONSES_SERVICE_TIERS = ["auto", "default"] as const;
export type OpenAiResponsesServiceTier = (typeof OPENAI_RESPONSES_SERVICE_TIERS)[number];

/** Exact request, continuation, retention, and stream policy for Responses. */
export type OpenAiResponsesTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "openai-responses";
  readonly systemMessageRole: OpenAiSystemMessageRole;
  readonly continuation: OpenAiResponsesContinuationMode;
  readonly store: boolean;
  readonly includeEncryptedReasoning: boolean;
  readonly reasoningSummary: OpenAiResponsesReasoningSummary;
  readonly promptCacheTtl: OpenAiResponsesPromptCacheTtl;
  readonly sessionAffinity: "prompt-cache-key";
  readonly serviceTier: OpenAiResponsesServiceTier;
  readonly streamObfuscation: boolean;
  readonly strictToolSchemas: boolean;
  readonly parallelToolCalls: boolean;
};

export const ANTHROPIC_SYSTEM_PROMPT_MODES = ["top-level-blocks"] as const;
export type AnthropicSystemPromptMode = (typeof ANTHROPIC_SYSTEM_PROMPT_MODES)[number];

export const ANTHROPIC_MAX_OUTPUT_TOKEN_FIELDS = ["max_tokens"] as const;
export type AnthropicMaxOutputTokenField = (typeof ANTHROPIC_MAX_OUTPUT_TOKEN_FIELDS)[number];

export const ANTHROPIC_THINKING_MODES = ["none", "adaptive"] as const;
export type AnthropicThinkingMode = (typeof ANTHROPIC_THINKING_MODES)[number];

export const ANTHROPIC_THINKING_REPLAY_MODES = ["none", "signed-blocks"] as const;
export type AnthropicThinkingReplayMode = (typeof ANTHROPIC_THINKING_REPLAY_MODES)[number];

export const ANTHROPIC_STRUCTURED_OUTPUT_MODES = ["none", "output-config-json-schema"] as const;
export type AnthropicStructuredOutputMode = (typeof ANTHROPIC_STRUCTURED_OUTPUT_MODES)[number];

export const ANTHROPIC_PROMPT_CACHE_PLACEMENTS = ["none", "system-prefix"] as const;
export type AnthropicPromptCachePlacement = (typeof ANTHROPIC_PROMPT_CACHE_PLACEMENTS)[number];

export const ANTHROPIC_PROMPT_CACHE_TTLS = ["5m", "1h"] as const;
export type AnthropicPromptCacheTtl = (typeof ANTHROPIC_PROMPT_CACHE_TTLS)[number];

export const ANTHROPIC_TOOL_RESULT_ORDERINGS = ["assistant-before-user"] as const;
export type AnthropicToolResultOrdering = (typeof ANTHROPIC_TOOL_RESULT_ORDERINGS)[number];

export const ANTHROPIC_STREAMING_USAGE_MODES = ["message-start-and-delta"] as const;
export type AnthropicStreamingUsageMode = (typeof ANTHROPIC_STREAMING_USAGE_MODES)[number];

export const ANTHROPIC_SERVICE_TIERS = ["auto", "standard_only"] as const;
export type AnthropicServiceTier = (typeof ANTHROPIC_SERVICE_TIERS)[number];

export const ANTHROPIC_API_VERSION_MODES = ["sdk-managed"] as const;
export type AnthropicApiVersionMode = (typeof ANTHROPIC_API_VERSION_MODES)[number];

export const ANTHROPIC_BETA_HEADER_MODES = ["none"] as const;
export type AnthropicBetaHeaderMode = (typeof ANTHROPIC_BETA_HEADER_MODES)[number];

export const ANTHROPIC_INPUT_ENCODINGS = ["text-blocks"] as const;
export type AnthropicInputEncoding = (typeof ANTHROPIC_INPUT_ENCODINGS)[number];

/** Exact request, continuation, cache, and stream policy for Anthropic Messages. */
export type AnthropicMessagesTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "anthropic-messages";
  readonly systemPrompt: AnthropicSystemPromptMode;
  readonly maxOutputTokensField: AnthropicMaxOutputTokenField;
  readonly thinking: AnthropicThinkingMode;
  readonly thinkingReplay: AnthropicThinkingReplayMode;
  readonly structuredOutput: AnthropicStructuredOutputMode;
  readonly promptCachePlacement: AnthropicPromptCachePlacement;
  readonly promptCacheTtl: AnthropicPromptCacheTtl | null;
  readonly toolResultOrdering: AnthropicToolResultOrdering;
  readonly strictToolSchemas: boolean;
  readonly streamingUsage: AnthropicStreamingUsageMode;
  readonly serviceTier: AnthropicServiceTier;
  readonly apiVersion: AnthropicApiVersionMode;
  readonly betaHeaders: AnthropicBetaHeaderMode;
  readonly inputEncoding: AnthropicInputEncoding;
};

export const GOOGLE_SYSTEM_INSTRUCTION_MODES = ["top-level"] as const;
export type GoogleSystemInstructionMode = (typeof GOOGLE_SYSTEM_INSTRUCTION_MODES)[number];

export const GOOGLE_ROLE_MAPPINGS = ["user-model"] as const;
export type GoogleRoleMapping = (typeof GOOGLE_ROLE_MAPPINGS)[number];

export const GOOGLE_MAX_OUTPUT_TOKEN_FIELDS = ["maxOutputTokens"] as const;
export type GoogleMaxOutputTokenField = (typeof GOOGLE_MAX_OUTPUT_TOKEN_FIELDS)[number];

export const GOOGLE_THINKING_MODES = ["thinking-level"] as const;
export type GoogleThinkingMode = (typeof GOOGLE_THINKING_MODES)[number];

export const GOOGLE_THINKING_REPLAY_MODES = ["part-signature"] as const;
export type GoogleThinkingReplayMode = (typeof GOOGLE_THINKING_REPLAY_MODES)[number];

export const GOOGLE_STRUCTURED_OUTPUT_MODES = ["response-json-schema"] as const;
export type GoogleStructuredOutputMode = (typeof GOOGLE_STRUCTURED_OUTPUT_MODES)[number];

export const GOOGLE_FUNCTION_CALL_IDENTITIES = ["provider-or-derived-position"] as const;
export type GoogleFunctionCallIdentity = (typeof GOOGLE_FUNCTION_CALL_IDENTITIES)[number];

export const GOOGLE_FUNCTION_RESPONSE_ORDERINGS = ["model-before-user"] as const;
export type GoogleFunctionResponseOrdering = (typeof GOOGLE_FUNCTION_RESPONSE_ORDERINGS)[number];

export const GOOGLE_PROMPT_CACHE_BINDINGS = ["implicit-or-bound-resource"] as const;
export type GooglePromptCacheBinding = (typeof GOOGLE_PROMPT_CACHE_BINDINGS)[number];

export const GOOGLE_SAFETY_MODES = ["prompt-feedback-and-finish-reason"] as const;
export type GoogleSafetyMode = (typeof GOOGLE_SAFETY_MODES)[number];

export const GOOGLE_STREAMING_MODES = ["single-candidate-parts"] as const;
export type GoogleStreamingMode = (typeof GOOGLE_STREAMING_MODES)[number];

export const GOOGLE_USAGE_MODES = ["response-usage-metadata"] as const;
export type GoogleUsageMode = (typeof GOOGLE_USAGE_MODES)[number];

export const GOOGLE_INPUT_ENCODINGS = ["text-parts"] as const;
export type GoogleInputEncoding = (typeof GOOGLE_INPUT_ENCODINGS)[number];

export const GOOGLE_API_VERSION_MODES = ["sdk-managed"] as const;
export type GoogleApiVersionMode = (typeof GOOGLE_API_VERSION_MODES)[number];

/** Exact request, continuation, cache-reference, and stream policy for Generate Content. */
export type GoogleGenerateContentTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "google-generate-content";
  readonly systemInstruction: GoogleSystemInstructionMode;
  readonly roleMapping: GoogleRoleMapping;
  readonly maxOutputTokensField: GoogleMaxOutputTokenField;
  readonly thinking: GoogleThinkingMode;
  readonly thinkingReplay: GoogleThinkingReplayMode;
  readonly structuredOutput: GoogleStructuredOutputMode;
  readonly functionCallIdentity: GoogleFunctionCallIdentity;
  readonly functionResponseOrdering: GoogleFunctionResponseOrdering;
  readonly promptCacheBinding: GooglePromptCacheBinding;
  readonly safety: GoogleSafetyMode;
  readonly streaming: GoogleStreamingMode;
  readonly usage: GoogleUsageMode;
  readonly inputEncoding: GoogleInputEncoding;
  readonly apiVersion: GoogleApiVersionMode;
  readonly automaticFunctionCalling: false;
};

export type CommandCodeTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "command-code-router";
};

export type DeterministicTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "deterministic";
};

export type CustomUnavailableTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "custom-unavailable";
};

export type ProviderTransportCompatibilityDeclaration =
  | OpenAiChatTransportCompatibilityDeclaration
  | OpenAiResponsesTransportCompatibilityDeclaration
  | AnthropicMessagesTransportCompatibilityDeclaration
  | GoogleGenerateContentTransportCompatibilityDeclaration
  | CommandCodeTransportCompatibilityDeclaration
  | DeterministicTransportCompatibilityDeclaration
  | CustomUnavailableTransportCompatibilityDeclaration;

export const PROVIDER_TRANSPORT_COMPATIBILITY_SOURCE_KINDS = [
  "provider-documentation",
  "user-declaration",
] as const;

export type ProviderTransportCompatibilitySourceKind =
  (typeof PROVIDER_TRANSPORT_COMPATIBILITY_SOURCE_KINDS)[number];

/** Audit metadata for an exact-model compatibility claim. It never grants authority. */
export type ProviderTransportCompatibilitySource = {
  readonly kind: ProviderTransportCompatibilitySourceKind;
  readonly url: string | null;
  readonly observedAt: string | null;
};

/** A compatibility declaration that applies only to one exact model identity. */
export type ProviderModelTransportCompatibilityOverride = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly modelId: ModelId;
  readonly declaration: ProviderTransportCompatibilityDeclaration;
  readonly source: ProviderTransportCompatibilitySource;
};

export type ProviderTransportCompatibilityProvenance =
  | "adapter-default"
  | "profile-declaration"
  | "model-override";

export type ProviderTransportCompatibilityLayer =
  | "adapter-default"
  | "destination-profile"
  | "model-override";

export type ProviderTransportCompatibilityLayerStatus =
  | "selected"
  | "superseded"
  | "absent"
  | "not-applicable";

export type ProviderTransportCompatibilityLayerReceipt = {
  readonly layer: ProviderTransportCompatibilityLayer;
  readonly status: ProviderTransportCompatibilityLayerStatus;
};

/** Secret-free explanation of the exact translation plan selected for an attempt. */
export type ProviderTransportCompatibilityReceipt = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly adapterKind: ProviderAdapterKind;
  readonly modelId: ModelId | null;
  readonly selectedLayer: ProviderTransportCompatibilityLayer;
  readonly source: ProviderTransportCompatibilitySource | null;
  readonly layers: readonly ProviderTransportCompatibilityLayerReceipt[];
};

export type ProviderTransportCompatibilityPlan = {
  readonly compatibilityId: string;
  readonly declaration: ProviderTransportCompatibilityDeclaration;
  readonly provenance: ProviderTransportCompatibilityProvenance;
  readonly receipt: ProviderTransportCompatibilityReceipt;
};

export type ProviderTransportCompatibilityResolution = Omit<
  ProviderTransportCompatibilityPlan,
  "compatibilityId"
>;

export type ProviderTransportCompatibilityError = {
  readonly code: "adapter-dialect-mismatch";
  readonly adapterKind: ProviderAdapterKind;
  readonly dialect: ProviderTransportDialect;
};

/** Compare a route receipt with the exact plan without relying on object identity. */
export function providerTransportCompatibilityReceiptMatchesPlan(
  receipt: ProviderTransportCompatibilityReceipt,
  plan: ProviderTransportCompatibilityPlan,
): boolean {
  const expected = plan.receipt;
  return (
    receipt.schemaVersion === expected.schemaVersion &&
    receipt.adapterKind === expected.adapterKind &&
    receipt.modelId === expected.modelId &&
    receipt.selectedLayer === expected.selectedLayer &&
    receipt.source?.kind === expected.source?.kind &&
    receipt.source?.url === expected.source?.url &&
    receipt.source?.observedAt === expected.source?.observedAt &&
    receipt.layers.length === expected.layers.length &&
    receipt.layers.every(
      (layer, index) =>
        layer.layer === expected.layers[index]?.layer &&
        layer.status === expected.layers[index]?.status,
    )
  );
}

/** Bind a destination plan to one exact model when no model override replaced it. */
export function bindProviderTransportCompatibilityToModel(
  plan: ProviderTransportCompatibilityPlan,
  selectedModelId: ModelId,
): ProviderTransportCompatibilityPlan {
  return {
    ...plan,
    receipt: {
      ...plan.receipt,
      modelId: selectedModelId,
      layers: plan.receipt.layers.map((layer) =>
        layer.layer === "model-override" && layer.status === "not-applicable"
          ? { ...layer, status: "absent" as const }
          : layer,
      ),
    },
  };
}

export const OPENAI_CHAT_TRANSPORT_DEFAULT: OpenAiChatTransportCompatibilityDeclaration = {
  schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
  dialect: "openai-chat-completions",
  systemMessageRole: "system",
  maxOutputTokensField: "max_completion_tokens",
  streamingUsage: "include",
  finishReason: "required",
  strictToolSchemas: false,
  toolResultName: "omit",
  assistantAfterToolResult: "none",
};

export const OPENAI_RESPONSES_TRANSPORT_DEFAULT: OpenAiResponsesTransportCompatibilityDeclaration =
  {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "openai-responses",
    systemMessageRole: "developer",
    continuation: "stateless",
    store: false,
    includeEncryptedReasoning: true,
    reasoningSummary: "auto",
    promptCacheTtl: "provider-default",
    sessionAffinity: "prompt-cache-key",
    serviceTier: "auto",
    streamObfuscation: true,
    strictToolSchemas: true,
    parallelToolCalls: true,
  };

export const ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT: AnthropicMessagesTransportCompatibilityDeclaration =
  {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "anthropic-messages",
    systemPrompt: "top-level-blocks",
    maxOutputTokensField: "max_tokens",
    thinking: "adaptive",
    thinkingReplay: "signed-blocks",
    structuredOutput: "output-config-json-schema",
    promptCachePlacement: "system-prefix",
    promptCacheTtl: "5m",
    toolResultOrdering: "assistant-before-user",
    strictToolSchemas: true,
    streamingUsage: "message-start-and-delta",
    serviceTier: "auto",
    apiVersion: "sdk-managed",
    betaHeaders: "none",
    inputEncoding: "text-blocks",
  };

export const GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT: GoogleGenerateContentTransportCompatibilityDeclaration =
  {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "google-generate-content",
    systemInstruction: "top-level",
    roleMapping: "user-model",
    maxOutputTokensField: "maxOutputTokens",
    thinking: "thinking-level",
    thinkingReplay: "part-signature",
    structuredOutput: "response-json-schema",
    functionCallIdentity: "provider-or-derived-position",
    functionResponseOrdering: "model-before-user",
    promptCacheBinding: "implicit-or-bound-resource",
    safety: "prompt-feedback-and-finish-reason",
    streaming: "single-candidate-parts",
    usage: "response-usage-metadata",
    inputEncoding: "text-parts",
    apiVersion: "sdk-managed",
    automaticFunctionCalling: false,
  };

const DEFAULT_DECLARATIONS: Readonly<
  Record<ProviderAdapterKind, ProviderTransportCompatibilityDeclaration>
> = {
  deterministic: {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "deterministic",
  },
  openai: OPENAI_CHAT_TRANSPORT_DEFAULT,
  anthropic: ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT,
  google: GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT,
  commandcode: {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "command-code-router",
  },
  custom: {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "custom-unavailable",
  },
};

const DEFAULT_COMPATIBILITY_IDS: Readonly<Record<ProviderAdapterKind, string>> = {
  deterministic: "sha-256:295d1812537ede14745552f9fe1fe8ae2bfaf0010f7ddc3ef1ad200b5a1c4da3",
  openai: "sha-256:0ce93cf5d370f82b9c340a26b77fb3c4c5f36c2f917d42356379246e4b1e590c",
  anthropic: "sha-256:9097c50ab7aca8ff19d70e22deb4cbc20aa34d3df35f1c81c0d5daf60b960baa",
  google: "sha-256:93788a5e4057d726c2d9054cc890c474abd6c091973e7b0fe25fc81143d35ceb",
  commandcode: "sha-256:ebe240ba24f73e0818135cb83b0e120f40a6e13c7728d8f93bd6d210195adcd0",
  custom: "sha-256:9e4c9376ebd5369a18ef0653485ab3086e8e73fc3484208ab6e8d603cf773d3a",
};

export function providerTransportCompatibilityMatchesAdapter(
  adapterKind: ProviderAdapterKind,
  declaration: ProviderTransportCompatibilityDeclaration,
): boolean {
  switch (adapterKind) {
    case "openai":
      return (
        declaration.dialect === "openai-chat-completions" ||
        declaration.dialect === "openai-responses"
      );
    case "anthropic":
      return declaration.dialect === "anthropic-messages";
    case "google":
      return declaration.dialect === "google-generate-content";
    case "commandcode":
      return declaration.dialect === "command-code-router";
    case "deterministic":
      return declaration.dialect === "deterministic";
    case "custom":
      return declaration.dialect === "custom-unavailable";
  }
}

function resolution(
  adapterKind: ProviderAdapterKind,
  declaration: ProviderTransportCompatibilityDeclaration,
  provenance: ProviderTransportCompatibilityProvenance,
  options: {
    readonly modelId: ModelId | null;
    readonly destinationPresent: boolean;
    readonly modelOverridePresent: boolean;
    readonly source: ProviderTransportCompatibilitySource | null;
  },
): ProviderTransportCompatibilityResolution {
  const selectedLayer: ProviderTransportCompatibilityLayer =
    provenance === "model-override"
      ? "model-override"
      : provenance === "profile-declaration"
        ? "destination-profile"
        : "adapter-default";
  return {
    declaration: canonicalDeclaration(declaration),
    provenance,
    receipt: {
      schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
      adapterKind,
      modelId: options.modelId,
      selectedLayer,
      source: options.source,
      layers: [
        {
          layer: "adapter-default",
          status: selectedLayer === "adapter-default" ? "selected" : "superseded",
        },
        {
          layer: "destination-profile",
          status:
            selectedLayer === "destination-profile"
              ? "selected"
              : options.destinationPresent
                ? "superseded"
                : "absent",
        },
        {
          layer: "model-override",
          status:
            selectedLayer === "model-override"
              ? "selected"
              : options.modelId === null
                ? "not-applicable"
                : options.modelOverridePresent
                  ? "superseded"
                  : "absent",
        },
      ],
    },
  };
}

function canonicalDeclaration(
  declaration: ProviderTransportCompatibilityDeclaration,
): ProviderTransportCompatibilityDeclaration {
  switch (declaration.dialect) {
    case "openai-chat-completions":
      return {
        schemaVersion: declaration.schemaVersion,
        dialect: declaration.dialect,
        systemMessageRole: declaration.systemMessageRole,
        maxOutputTokensField: declaration.maxOutputTokensField,
        streamingUsage: declaration.streamingUsage,
        finishReason: declaration.finishReason,
        strictToolSchemas: declaration.strictToolSchemas,
        toolResultName: declaration.toolResultName,
        assistantAfterToolResult: declaration.assistantAfterToolResult,
      };
    case "openai-responses":
      return {
        schemaVersion: declaration.schemaVersion,
        dialect: declaration.dialect,
        systemMessageRole: declaration.systemMessageRole,
        continuation: declaration.continuation,
        store: declaration.store,
        includeEncryptedReasoning: declaration.includeEncryptedReasoning,
        reasoningSummary: declaration.reasoningSummary,
        promptCacheTtl: declaration.promptCacheTtl,
        sessionAffinity: declaration.sessionAffinity,
        serviceTier: declaration.serviceTier,
        streamObfuscation: declaration.streamObfuscation,
        strictToolSchemas: declaration.strictToolSchemas,
        parallelToolCalls: declaration.parallelToolCalls,
      };
    case "anthropic-messages":
      return {
        schemaVersion: declaration.schemaVersion,
        dialect: declaration.dialect,
        systemPrompt: declaration.systemPrompt,
        maxOutputTokensField: declaration.maxOutputTokensField,
        thinking: declaration.thinking,
        thinkingReplay: declaration.thinkingReplay,
        structuredOutput: declaration.structuredOutput,
        promptCachePlacement: declaration.promptCachePlacement,
        promptCacheTtl: declaration.promptCacheTtl,
        toolResultOrdering: declaration.toolResultOrdering,
        strictToolSchemas: declaration.strictToolSchemas,
        streamingUsage: declaration.streamingUsage,
        serviceTier: declaration.serviceTier,
        apiVersion: declaration.apiVersion,
        betaHeaders: declaration.betaHeaders,
        inputEncoding: declaration.inputEncoding,
      };
    case "google-generate-content":
      return {
        schemaVersion: declaration.schemaVersion,
        dialect: declaration.dialect,
        systemInstruction: declaration.systemInstruction,
        roleMapping: declaration.roleMapping,
        maxOutputTokensField: declaration.maxOutputTokensField,
        thinking: declaration.thinking,
        thinkingReplay: declaration.thinkingReplay,
        structuredOutput: declaration.structuredOutput,
        functionCallIdentity: declaration.functionCallIdentity,
        functionResponseOrdering: declaration.functionResponseOrdering,
        promptCacheBinding: declaration.promptCacheBinding,
        safety: declaration.safety,
        streaming: declaration.streaming,
        usage: declaration.usage,
        inputEncoding: declaration.inputEncoding,
        apiVersion: declaration.apiVersion,
        automaticFunctionCalling: declaration.automaticFunctionCalling,
      };
    case "command-code-router":
    case "deterministic":
    case "custom-unavailable":
      return {
        schemaVersion: declaration.schemaVersion,
        dialect: declaration.dialect,
      };
  }
}

export function defaultProviderTransportCompatibility(
  adapterKind: ProviderAdapterKind,
): ProviderTransportCompatibilityPlan {
  return {
    ...resolution(adapterKind, DEFAULT_DECLARATIONS[adapterKind], "adapter-default", {
      modelId: null,
      destinationPresent: false,
      modelOverridePresent: false,
      source: null,
    }),
    compatibilityId: DEFAULT_COMPATIBILITY_IDS[adapterKind],
  };
}

export function resolveProviderTransportCompatibility(
  adapterKind: ProviderAdapterKind,
  declaration?: ProviderTransportCompatibilityDeclaration | null,
  options: {
    readonly modelId?: ModelId;
    readonly modelOverrides?: readonly ProviderModelTransportCompatibilityOverride[];
  } = {},
):
  | { readonly ok: true; readonly value: ProviderTransportCompatibilityResolution }
  | { readonly ok: false; readonly error: ProviderTransportCompatibilityError } {
  const modelId = options.modelId ?? null;
  const modelOverride =
    modelId === null
      ? undefined
      : options.modelOverrides?.find((candidate) => candidate.modelId === modelId);
  const selected = modelOverride?.declaration ?? declaration ?? DEFAULT_DECLARATIONS[adapterKind];
  if (!providerTransportCompatibilityMatchesAdapter(adapterKind, selected)) {
    return {
      ok: false,
      error: {
        code: "adapter-dialect-mismatch",
        adapterKind,
        dialect: selected.dialect,
      },
    };
  }
  const provenance: ProviderTransportCompatibilityProvenance =
    modelOverride !== undefined
      ? "model-override"
      : declaration !== undefined && declaration !== null
        ? "profile-declaration"
        : "adapter-default";
  return {
    ok: true,
    value: resolution(adapterKind, selected, provenance, {
      modelId,
      destinationPresent: declaration !== undefined && declaration !== null,
      modelOverridePresent: modelOverride !== undefined,
      source: modelOverride?.source ?? null,
    }),
  };
}
