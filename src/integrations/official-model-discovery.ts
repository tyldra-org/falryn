/** Official-SDK model discovery translated into Falryn's provider-neutral catalog. */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelInfo as AnthropicModelInfo } from "@anthropic-ai/sdk/resources/models";
import { GoogleGenAI, type Model as GoogleModel } from "@google/genai";
import OpenAI from "openai";
import type { Model as OpenAiModel } from "openai/resources/models";

import { type Instant, instant } from "../domain/clock.ts";
import { modelId } from "../domain/identity.ts";
import { COMMAND_CODE_OPENAI_BASE_URL } from "../providers/command-code.ts";
import type { DiscoveryOutcome, ModelCatalog, ModelDiscoveryPort } from "../providers/discovery.ts";
import { MAX_PROVIDER_METADATA_ENTRY_LENGTH } from "../providers/limits.ts";
import {
  MODEL_CAPABILITY_SCHEMA_VERSION,
  type ModelCapability,
  type ModelFeatureSupport,
  unknownModelCapability,
} from "../providers/model-capability.ts";
import type { ProviderProfile } from "../providers/profile.ts";

export type CommandCodeModelInfo = OpenAiModel & {
  readonly name?: unknown;
  readonly context_length?: unknown;
};

type ResolveProviderApiKey = (
  profile: ProviderProfile,
  signal: AbortSignal,
) => Promise<string | null>;

export type OfficialModelDiscoveryLoaders = {
  readonly openai: (
    profile: ProviderProfile,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<readonly OpenAiModel[]>;
  readonly anthropic: (
    profile: ProviderProfile,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<readonly AnthropicModelInfo[]>;
  readonly google: (
    profile: ProviderProfile,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<readonly GoogleModel[]>;
  readonly commandcode: (
    profile: ProviderProfile,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<readonly CommandCodeModelInfo[]>;
};

export type OfficialModelDiscoveryOptions = {
  readonly resolveApiKey: ResolveProviderApiKey;
  readonly loaders?: Partial<OfficialModelDiscoveryLoaders> | undefined;
  readonly generation?: number | undefined;
  readonly ttlMs?: number | undefined;
};

const MAX_DISCOVERED_MODELS = 1_000;

class ModelDiscoveryContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ModelDiscoveryContractError";
    this.code = code;
  }
}

function remoteModelId(value: unknown): ReturnType<typeof modelId.from> {
  const parsed = modelId.parse(value);
  if (!parsed.ok) {
    throw new ModelDiscoveryContractError("provider-model-record-malformed");
  }
  return parsed.value;
}

function displayName(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_METADATA_ENTRY_LENGTH
  ) {
    throw new ModelDiscoveryContractError("provider-model-record-malformed");
  }
  return value;
}

function tokenLimit(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 100_000_000) {
    throw new ModelDiscoveryContractError("provider-model-record-malformed");
  }
  return Number(value);
}

function boundedRecords<Value>(value: readonly Value[]): readonly Value[] {
  if (!Array.isArray(value)) {
    throw new ModelDiscoveryContractError("provider-model-catalog-malformed");
  }
  if (value.length > MAX_DISCOVERED_MODELS) {
    throw new ModelDiscoveryContractError("provider-model-catalog-too-large");
  }
  return value;
}

function support(value: boolean | null | undefined): ModelFeatureSupport {
  return value === true ? "supported" : value === false ? "unsupported" : "unknown";
}

function openAiCapability(record: OpenAiModel): ModelCapability {
  const id = remoteModelId(record.id);
  return {
    ...unknownModelCapability(id, {
      availability: "available",
      provenance: ["remote-identity"],
    }),
    displayName: String(id),
  };
}

function commandCodeCapability(record: CommandCodeModelInfo): ModelCapability {
  const id = remoteModelId(record.id);
  return {
    ...unknownModelCapability(id, {
      availability: "available",
      provenance: ["remote-identity"],
    }),
    displayName: displayName(record.name, String(id)),
    contextTokens: tokenLimit(record.context_length),
  };
}

function anthropicCapability(record: AnthropicModelInfo): ModelCapability {
  const id = remoteModelId(record.id);
  const capabilities = record.capabilities;
  const controls: string[] = [];
  if (capabilities?.effort.supported === true) {
    for (const level of ["low", "medium", "high", "max"] as const) {
      if (capabilities.effort[level].supported) {
        controls.push(level);
      }
    }
    if (capabilities.effort.xhigh?.supported === true) {
      controls.push("xhigh");
    }
  }
  if (capabilities?.thinking.types.adaptive.supported === true) {
    controls.push("adaptive");
  }
  if (capabilities?.thinking.types.enabled.supported === true) {
    controls.push("enabled");
  }

  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    modelId: id,
    displayName: displayName(record.display_name, String(id)),
    inputModalities: [
      "text",
      ...(capabilities?.image_input.supported === true ? (["image"] as const) : []),
      ...(capabilities?.pdf_input.supported === true ? (["document"] as const) : []),
    ],
    outputModalities: ["text"],
    // The Models API does not currently publish model-specific custom-tool support.
    tools: "unknown",
    structuredOutput: support(capabilities?.structured_outputs.supported),
    // Listed Claude models use the Messages streaming protocol.
    streaming: "supported",
    reasoning: support(
      capabilities === null
        ? undefined
        : capabilities?.effort.supported === true || capabilities?.thinking.supported === true,
    ),
    reasoningControls: controls,
    contextTokens: tokenLimit(record.max_input_tokens),
    outputTokens: tokenLimit(record.max_tokens),
    completeness: "partial",
    availability: "available",
    provenance: ["provider-manifest"],
  };
}

function normalizeGoogleModelId(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

function googleCapability(record: GoogleModel): ModelCapability {
  if (record.name === undefined || record.name.length === 0) {
    throw new ModelDiscoveryContractError("provider-model-record-malformed");
  }
  const id = normalizeGoogleModelId(record.name);
  const actions = new Set(record.supportedActions ?? []);
  const generatesContent = actions.has("generateContent") || actions.has("generate_content");
  return {
    schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
    modelId: remoteModelId(id),
    displayName: displayName(record.displayName, id),
    inputModalities: generatesContent ? ["text"] : [],
    outputModalities: generatesContent ? ["text"] : [],
    // Gemini's Models API does not enumerate these per-model capabilities.
    tools: "unknown",
    structuredOutput: "unknown",
    streaming: "unknown",
    reasoning: support(record.thinking),
    reasoningControls: record.thinking === true ? ["provider-default"] : [],
    contextTokens: tokenLimit(record.inputTokenLimit),
    outputTokens: tokenLimit(record.outputTokenLimit),
    completeness: "partial",
    availability: "available",
    provenance: ["provider-manifest"],
  };
}

function uniqueCapabilities(models: readonly ModelCapability[]): readonly ModelCapability[] {
  const seen = new Set<string>();
  for (const capability of models) {
    const id = String(capability.modelId);
    if (seen.has(id)) {
      throw new ModelDiscoveryContractError("provider-model-record-duplicate");
    }
    seen.add(id);
  }
  return models;
}

async function loadOpenAiModels(
  profile: ProviderProfile,
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly OpenAiModel[]> {
  const client = new OpenAI({
    apiKey,
    baseURL: profile.endpoint ?? undefined,
    organization: profile.organization,
    project: profile.project,
    maxRetries: 0,
    timeout: profile.timeouts.requestMs,
    logLevel: "off",
  });
  const page = await client.models.list({ signal });
  const models: OpenAiModel[] = [];
  for await (const record of page) {
    if (models.length === MAX_DISCOVERED_MODELS) {
      throw new ModelDiscoveryContractError("provider-model-catalog-too-large");
    }
    models.push(record);
  }
  return models;
}

async function loadCommandCodeModels(
  profile: ProviderProfile,
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly CommandCodeModelInfo[]> {
  const client = new OpenAI({
    apiKey,
    baseURL: profile.endpoint ?? COMMAND_CODE_OPENAI_BASE_URL,
    maxRetries: 0,
    timeout: profile.timeouts.requestMs,
    logLevel: "off",
  });
  const page = await client.models.list({ signal });
  const models: CommandCodeModelInfo[] = [];
  for await (const record of page) {
    if (models.length === MAX_DISCOVERED_MODELS) {
      throw new ModelDiscoveryContractError("provider-model-catalog-too-large");
    }
    models.push({
      ...record,
      name: Reflect.get(record, "name"),
      context_length: Reflect.get(record, "context_length"),
    });
  }
  return models;
}

async function loadAnthropicModels(
  profile: ProviderProfile,
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly AnthropicModelInfo[]> {
  const client = new Anthropic({
    apiKey,
    baseURL: profile.endpoint,
    maxRetries: 0,
    timeout: profile.timeouts.requestMs,
    logLevel: "off",
  });
  const page = await client.models.list({ limit: 1_000 }, { signal });
  const models: AnthropicModelInfo[] = [];
  for await (const record of page) {
    if (models.length === MAX_DISCOVERED_MODELS) {
      throw new ModelDiscoveryContractError("provider-model-catalog-too-large");
    }
    models.push(record);
  }
  return models;
}

async function loadGoogleModels(
  profile: ProviderProfile,
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly GoogleModel[]> {
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(profile.endpoint === null ? {} : { baseUrl: profile.endpoint }),
      timeout: profile.timeouts.requestMs,
      retryOptions: { attempts: 1 },
    },
  });
  const page = await client.models.list({
    config: { pageSize: 1_000, abortSignal: signal },
  });
  const models: GoogleModel[] = [];
  for await (const record of page) {
    if (models.length === MAX_DISCOVERED_MODELS) {
      throw new ModelDiscoveryContractError("provider-model-catalog-too-large");
    }
    models.push(record);
  }
  return models;
}

function failure(error: unknown, signal: AbortSignal): DiscoveryOutcome {
  if (signal.aborted) {
    return {
      kind: "failed",
      failure: { kind: "cancelled", code: "discovery-aborted", retryable: false },
    };
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || /timeout/iu.test(error.name))
  ) {
    return {
      kind: "failed",
      failure: { kind: "timed-out", code: "provider-discovery-timed-out", retryable: true },
    };
  }
  if (error instanceof ModelDiscoveryContractError) {
    return {
      kind: "failed",
      failure: { kind: "malformed", code: error.code, retryable: false },
    };
  }
  const status =
    typeof error === "object" && error !== null && typeof Reflect.get(error, "status") === "number"
      ? Number(Reflect.get(error, "status"))
      : null;
  if (status === 401 || status === 403) {
    return {
      kind: "failed",
      failure: {
        kind: "authentication",
        code: "provider-discovery-authentication",
        retryable: false,
      },
    };
  }
  if (status === 429) {
    return {
      kind: "failed",
      failure: { kind: "rate-limited", code: "provider-discovery-rate-limited", retryable: true },
    };
  }
  return {
    kind: "failed",
    failure: { kind: "unavailable", code: "provider-discovery-unavailable", retryable: true },
  };
}

function markEnabledModels(
  profile: ProviderProfile,
  discovered: readonly ModelCapability[],
): readonly ModelCapability[] {
  const byId = new Map(discovered.map((capability) => [String(capability.modelId), capability]));
  return profile.enabledModels.map((enabled) => {
    const capability = byId.get(String(enabled));
    if (capability !== undefined) {
      return capability;
    }
    return unknownModelCapability(enabled, {
      availability: "unavailable",
      provenance: ["remote-identity"],
    });
  });
}

function catalog(
  profile: ProviderProfile,
  models: readonly ModelCapability[],
  now: Instant,
  generation: number,
  ttlMs: number,
): ModelCatalog {
  return {
    generation,
    provenance: "remote-discovery",
    fetchedAt: now,
    expiresAt: instant(Number(now) + ttlMs),
    models: markEnabledModels(profile, models),
  };
}

/** Discover enabled model facts through the provider's official TypeScript SDK. */
export function createOfficialModelDiscovery(
  options: OfficialModelDiscoveryOptions,
): ModelDiscoveryPort {
  const loaders: OfficialModelDiscoveryLoaders = {
    openai: options.loaders?.openai ?? loadOpenAiModels,
    anthropic: options.loaders?.anthropic ?? loadAnthropicModels,
    google: options.loaders?.google ?? loadGoogleModels,
    commandcode: options.loaders?.commandcode ?? loadCommandCodeModels,
  };
  let nextGeneration = options.generation ?? 0;
  const ttlMs = options.ttlMs ?? 15 * 60_000;

  const publish = (
    profile: ProviderProfile,
    models: readonly ModelCapability[],
    now: Instant,
  ): DiscoveryOutcome => {
    const generation =
      options.generation === undefined ? Math.max(nextGeneration, Number(now)) : nextGeneration;
    nextGeneration += 1;
    return {
      kind: "catalog",
      catalog: catalog(profile, uniqueCapabilities(models), now, generation, ttlMs),
    };
  };

  return {
    async discover(profile, discoveryOptions): Promise<DiscoveryOutcome> {
      if (discoveryOptions.signal.aborted) {
        return failure(new DOMException("aborted", "AbortError"), discoveryOptions.signal);
      }
      if (profile.discovery !== "remote") {
        return {
          kind: "failed",
          failure: { kind: "unsupported-policy", code: "profile-not-remote", retryable: false },
        };
      }
      if (profile.adapterKind === "custom" || profile.adapterKind === "deterministic") {
        return {
          kind: "failed",
          failure: {
            kind: "unsupported-policy",
            code: "official-discovery-unsupported-adapter",
            retryable: false,
          },
        };
      }
      let apiKey: string | null;
      try {
        apiKey = await options.resolveApiKey(profile, discoveryOptions.signal);
      } catch (error) {
        return failure(error, discoveryOptions.signal);
      }
      if (apiKey === null) {
        return {
          kind: "failed",
          failure: {
            kind: "unavailable",
            code: "provider-credential-unavailable",
            retryable: false,
          },
        };
      }

      try {
        switch (profile.adapterKind) {
          case "openai": {
            const records = await loaders.openai(profile, apiKey, discoveryOptions.signal);
            return publish(
              profile,
              boundedRecords(records).map(openAiCapability),
              discoveryOptions.now,
            );
          }
          case "anthropic": {
            const records = await loaders.anthropic(profile, apiKey, discoveryOptions.signal);
            return publish(
              profile,
              boundedRecords(records).map(anthropicCapability),
              discoveryOptions.now,
            );
          }
          case "google": {
            const records = await loaders.google(profile, apiKey, discoveryOptions.signal);
            return publish(
              profile,
              boundedRecords(records).map(googleCapability),
              discoveryOptions.now,
            );
          }
          case "commandcode": {
            const records = await loaders.commandcode(profile, apiKey, discoveryOptions.signal);
            return publish(
              profile,
              boundedRecords(records).map(commandCodeCapability),
              discoveryOptions.now,
            );
          }
          default: {
            const exhaustive: never = profile.adapterKind;
            return exhaustive;
          }
        }
      } catch (error) {
        return failure(error, discoveryOptions.signal);
      }
    },
  };
}

export const officialModelCapabilityTranslators = {
  openai: openAiCapability,
  anthropic: anthropicCapability,
  google: googleCapability,
  commandcode: commandCodeCapability,
} as const;
