import type {
  CreateCachedContentParameters,
  GenerateContentParameters,
  GenerateContentResponse,
} from "@google/genai";
import type { ModelId } from "../../../domain/foundation/identity.ts";
import type {
  GoogleGenerateContentTransportCompatibilityDeclaration,
  ProviderModelTransportCompatibilityOverride,
} from "../../../providers/configuration/transport-compatibility.ts";
import type { ProviderContinuationStatePort } from "../../../providers/protocol/continuation-state.ts";

export type GoogleGenAiStreamFactory = (
  apiKey: string,
  request: GenerateContentParameters,
) => Promise<AsyncIterable<GenerateContentResponse>>;

export type GoogleCachedContentBinding = {
  readonly kind: "bound";
  readonly name: string;
  readonly cacheWriteInputTokens: number;
};

export type GoogleCachedContentBindingPort = {
  resolve(input: {
    readonly profileId: string;
    readonly providerId: string;
    readonly destinationId: string;
    readonly modelId: ModelId;
    readonly transportCompatibilityId: string;
    readonly cacheKey: string;
    readonly stablePrefixDigest: string;
    readonly create: CreateCachedContentParameters;
    readonly signal: AbortSignal;
  }): Promise<GoogleCachedContentBinding | { readonly kind: "unavailable" }>;
};

export type GoogleGenAiSdkAdapterOptions = {
  readonly profileId: string;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly baseUrl?: string | null;
  readonly resolveApiKey: (signal: AbortSignal) => Promise<string | null>;
  readonly supportedModels: readonly string[];
  readonly requestTimeoutMs?: number;
  /** Deterministic SDK boundary used by tests. Production leaves this absent. */
  readonly createStream?: GoogleGenAiStreamFactory;
  /** #843 owns creation, persistence, expiry, and deletion behind this port. */
  readonly cachedContent?: GoogleCachedContentBindingPort;
  readonly compatibility?: GoogleGenerateContentTransportCompatibilityDeclaration;
  readonly modelCompatibility?: readonly ProviderModelTransportCompatibilityOverride[];
  readonly continuationState?: ProviderContinuationStatePort;
  /** Injectable for deterministic persistence fixtures. */
  readonly now?: () => number;
};

export type ToolCallState = {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
};

export type SignedThoughtPart = {
  readonly text: string;
  readonly thought: true;
  readonly thoughtSignature: string;
};

export type RetainedContinuation = {
  readonly signedThoughts: readonly SignedThoughtPart[];
  readonly functionThoughtSignature: string | null;
};
