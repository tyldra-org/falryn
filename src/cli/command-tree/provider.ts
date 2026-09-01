/** Provider action argument normalization. Secret bytes are never accepted here. */

import { modelId, providerId } from "../../domain/index.ts";
import {
  type DiscoveryPolicy,
  isDiscoveryPolicy,
  isModelCatalogId,
  isProviderAdapterKind,
  openAiCodexProfilePolicyIssue,
  type ProviderAdapterKind,
  type ProviderAuthMethod,
  type ProviderProfile,
  providerEnvironmentCredentialReference,
} from "../../providers/index.ts";
import type { ProviderCommandArguments, RawArguments, RunnableCommand } from "./contracts.ts";

const ACTIONS = ["list", "add", "use", "configure", "test", "login", "logout", "remove"] as const;

type ProviderAction = (typeof ACTIONS)[number];

const PROFILE_OPTIONS = [
  "provider",
  "adapter",
  "name",
  "endpoint",
  "model",
  "catalog",
  "discovery",
  "organization",
  "project",
  "connect-timeout",
  "request-timeout",
] as const;

const LOGIN_OPTIONS = ["auth-method", "api-key-stdin", "account-label"] as const;

export function providerArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ProviderCommandArguments | null | string {
  if (command !== "provider") {
    return null;
  }
  const action = parsed.action;
  if (!isProviderAction(action)) {
    return "Provider action must be list, add, use, configure, test, login, logout, or remove.";
  }
  const allowed =
    action === "add" || action === "configure"
      ? PROFILE_OPTIONS
      : action === "login"
        ? LOGIN_OPTIONS
        : [];
  const unexpected = unexpectedOption(parsed, allowed);
  if (unexpected !== null) {
    return `Argument ${unexpected} is not valid with provider ${action}.`;
  }
  if (action === "list") {
    return parsed.id === undefined
      ? { action: "list" }
      : "Argument id is not valid with provider list.";
  }
  const id = parsed.id?.trim();
  if (id === undefined || id === "") {
    return `Argument id is required for provider ${action}.`;
  }
  if (action === "use" || action === "test" || action === "logout" || action === "remove") {
    return { action, profileId: id };
  }
  if (action === "login") {
    const method = parsed["auth-method"] ?? "api-key";
    if (method !== "api-key" && method !== "oauth-pkce" && method !== "device-code") {
      return `Argument auth-method: "${method}" is not valid.`;
    }
    if (method === "api-key" && parsed["api-key-stdin"] !== true) {
      return "Provider API-key login requires --api-key-stdin; credentials are never accepted in argv.";
    }
    if (method !== "api-key" && parsed["api-key-stdin"] === true) {
      return "Argument api-key-stdin is only valid with auth-method api-key.";
    }
    return {
      action: "login",
      profileId: id,
      method: method as ProviderAuthMethod,
      accountLabel: parsed["account-label"] ?? null,
    };
  }

  const profile = profileFrom(id, parsed);
  if (typeof profile === "string") {
    return profile;
  }
  return { action, profile };
}

function unexpectedOption(parsed: RawArguments, allowed: readonly string[]): string | null {
  for (const name of [...PROFILE_OPTIONS, ...LOGIN_OPTIONS]) {
    if (allowed.includes(name)) {
      continue;
    }
    const value = parsed[name as keyof RawArguments];
    if (value !== undefined && value !== false) {
      return name;
    }
  }
  return null;
}

function isProviderAction(value: string | undefined): value is ProviderAction {
  return value !== undefined && (ACTIONS as readonly string[]).includes(value);
}

function profileFrom(id: string, parsed: RawArguments): ProviderProfile | string {
  const provider = parsed.provider ?? id;
  const adapterResult = adapterFor(provider, parsed.adapter);
  if (!adapterResult.ok) {
    return adapterResult.message;
  }
  const adapter = adapterResult.value;
  const endpointResult = endpointFor(provider, adapter, parsed.endpoint);
  if (!endpointResult.ok) {
    return endpointResult.message;
  }
  const discoveryResult = discoveryFor(provider, adapter, endpointResult.value, parsed.discovery);
  if (!discoveryResult.ok) {
    return discoveryResult.message;
  }
  const models = parsed.model ?? [];
  if (models.length === 0) {
    return "At least one --model is required for provider add and configure.";
  }
  const catalogs = parsed.catalog ?? [];
  if (catalogs.some((catalog) => !isModelCatalogId(catalog))) {
    return "Every --catalog must be a legal catalog identity.";
  }
  const credential = isOfficialSdkDestination(provider, adapter, endpointResult.value)
    ? providerEnvironmentCredentialReference(provider, id)
    : null;
  const profile: ProviderProfile = {
    profileId: id,
    providerId: providerId.from(provider),
    adapterKind: adapter,
    displayName: parsed.name ?? id,
    endpoint: endpointResult.value,
    credential,
    organization: parsed.organization ?? null,
    project: parsed.project ?? null,
    enabledModels: models.map(modelId.from),
    catalogs,
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: discoveryResult.value,
    timeouts: {
      connectMs: parsed["connect-timeout"] ?? 15_000,
      requestMs: parsed["request-timeout"] ?? 120_000,
    },
  };
  const openAiCodexIssue = openAiCodexProfilePolicyIssue({
    ...profile,
    providerId: String(profile.providerId),
  });
  return openAiCodexIssue === null ? profile : openAiCodexIssue.message;
}

const OFFICIAL_PROVIDER_ADAPTERS: Readonly<Partial<Record<string, ProviderAdapterKind>>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  commandcode: "commandcode",
  "openai-codex": "openai-codex",
};

type ProviderArgumentResolution<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function adapterFor(
  provider: string,
  requested: string | undefined,
): ProviderArgumentResolution<ProviderAdapterKind> {
  if (requested === undefined) {
    const official = OFFICIAL_PROVIDER_ADAPTERS[provider];
    return official === undefined
      ? { ok: false, message: `Provider "${provider}" requires an explicit --adapter.` }
      : { ok: true, value: official };
  }
  const adapter = requested;
  if (!isProviderAdapterKind(adapter)) {
    return { ok: false, message: `Argument adapter: "${adapter}" is not valid.` };
  }
  const openAiCodexIssue = openAiCodexProfilePolicyIssue({
    providerId: provider,
    adapterKind: adapter,
    endpoint: null,
    credential: null,
    discovery: "static",
  });
  return openAiCodexIssue === null
    ? { ok: true, value: adapter }
    : { ok: false, message: openAiCodexIssue.message };
}

function discoveryFor(
  provider: string,
  adapter: ProviderAdapterKind,
  endpoint: string | null,
  requested: string | undefined,
): ProviderArgumentResolution<DiscoveryPolicy> {
  const discovery =
    requested ?? (isOfficialSdkDestination(provider, adapter, endpoint) ? "remote" : "static");
  if (isDiscoveryPolicy(discovery)) {
    return { ok: true, value: discovery };
  }
  return { ok: false, message: `Argument discovery: "${discovery}" is not valid.` };
}

function endpointFor(
  provider: string,
  adapter: ProviderAdapterKind,
  requested: string | undefined,
): ProviderArgumentResolution<string | null> {
  if (requested !== undefined) {
    return { ok: true, value: requested };
  }
  if (adapter === "deterministic") {
    return { ok: true, value: null };
  }
  if (OFFICIAL_PROVIDER_ADAPTERS[provider] !== adapter) {
    return {
      ok: false,
      message: `Provider "${provider}" using adapter "${adapter}" requires an explicit --endpoint.`,
    };
  }
  if (provider === "openai") {
    return { ok: true, value: "https://api.openai.com/v1" };
  }
  if (provider === "commandcode") {
    return { ok: true, value: "https://api.commandcode.ai/provider/v1" };
  }
  return { ok: true, value: null };
}

function isOfficialSdkDestination(
  provider: string,
  adapter: ProviderAdapterKind,
  endpoint: string | null,
): boolean {
  if (OFFICIAL_PROVIDER_ADAPTERS[provider] !== adapter || provider === "openai-codex") {
    return false;
  }
  if (provider === "openai") {
    return endpoint === "https://api.openai.com/v1";
  }
  if (provider === "commandcode") {
    return endpoint === "https://api.commandcode.ai/provider/v1";
  }
  return endpoint === null;
}
