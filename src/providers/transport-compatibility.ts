/** Versioned provider wire-compatibility declarations and immutable plans. */

import type { ProviderAdapterKind } from "./adapter-kind.ts";

export const PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION = 1;

export const PROVIDER_TRANSPORT_DIALECTS = [
  "openai-chat-completions",
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

export type AnthropicMessagesTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "anthropic-messages";
};

export type GoogleGenerateContentTransportCompatibilityDeclaration = {
  readonly schemaVersion: typeof PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION;
  readonly dialect: "google-generate-content";
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
  | AnthropicMessagesTransportCompatibilityDeclaration
  | GoogleGenerateContentTransportCompatibilityDeclaration
  | CommandCodeTransportCompatibilityDeclaration
  | DeterministicTransportCompatibilityDeclaration
  | CustomUnavailableTransportCompatibilityDeclaration;

export type ProviderTransportCompatibilityProvenance = "adapter-default" | "profile-declaration";

export type ProviderTransportCompatibilityPlan = {
  readonly compatibilityId: string;
  readonly declaration: ProviderTransportCompatibilityDeclaration;
  readonly provenance: ProviderTransportCompatibilityProvenance;
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

const DEFAULT_DECLARATIONS: Readonly<
  Record<ProviderAdapterKind, ProviderTransportCompatibilityDeclaration>
> = {
  deterministic: {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "deterministic",
  },
  openai: OPENAI_CHAT_TRANSPORT_DEFAULT,
  anthropic: {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "anthropic-messages",
  },
  google: {
    schemaVersion: PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
    dialect: "google-generate-content",
  },
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
  anthropic: "sha-256:bd4b92183e4fd81802f804afb15d93b94977a36462ba77e409089cdea8d15a8b",
  google: "sha-256:dfd8cce1aa9dd538b096e6fd5d311217944213f40d65cc98239f4b61ed6b054a",
  commandcode: "sha-256:ebe240ba24f73e0818135cb83b0e120f40a6e13c7728d8f93bd6d210195adcd0",
  custom: "sha-256:9e4c9376ebd5369a18ef0653485ab3086e8e73fc3484208ab6e8d603cf773d3a",
};

export function providerTransportCompatibilityMatchesAdapter(
  adapterKind: ProviderAdapterKind,
  declaration: ProviderTransportCompatibilityDeclaration,
): boolean {
  switch (adapterKind) {
    case "openai":
      return declaration.dialect === "openai-chat-completions";
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
  declaration: ProviderTransportCompatibilityDeclaration,
  provenance: ProviderTransportCompatibilityProvenance,
): ProviderTransportCompatibilityResolution {
  return { declaration: canonicalDeclaration(declaration), provenance };
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
    case "anthropic-messages":
    case "google-generate-content":
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
    ...resolution(DEFAULT_DECLARATIONS[adapterKind], "adapter-default"),
    compatibilityId: DEFAULT_COMPATIBILITY_IDS[adapterKind],
  };
}

export function resolveProviderTransportCompatibility(
  adapterKind: ProviderAdapterKind,
  declaration?: ProviderTransportCompatibilityDeclaration | null,
):
  | { readonly ok: true; readonly value: ProviderTransportCompatibilityResolution }
  | { readonly ok: false; readonly error: ProviderTransportCompatibilityError } {
  if (declaration === undefined || declaration === null) {
    return { ok: true, value: defaultProviderTransportCompatibility(adapterKind) };
  }
  if (!providerTransportCompatibilityMatchesAdapter(adapterKind, declaration)) {
    return {
      ok: false,
      error: {
        code: "adapter-dialect-mismatch",
        adapterKind,
        dialect: declaration.dialect,
      },
    };
  }
  return { ok: true, value: resolution(declaration, "profile-declaration") };
}
