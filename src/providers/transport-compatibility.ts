/** Versioned provider wire-compatibility declarations and immutable plans. */

import type { ModelId } from "../domain/identity.ts";
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
