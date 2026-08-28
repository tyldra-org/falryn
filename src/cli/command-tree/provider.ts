/** Provider action argument normalization. Secret bytes are never accepted here. */

import { modelId, providerId } from "../../domain/index.ts";
import {
  isDiscoveryPolicy,
  isModelCatalogId,
  isProviderAdapterKind,
  type ProviderAuthMethod,
  type ProviderProfile,
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
  const adapter = parsed.adapter ?? "openai";
  if (!isProviderAdapterKind(adapter)) {
    return `Argument adapter: "${adapter}" is not valid.`;
  }
  const discovery = parsed.discovery ?? "static";
  if (!isDiscoveryPolicy(discovery)) {
    return `Argument discovery: "${discovery}" is not valid.`;
  }
  const models = parsed.model ?? [];
  if (models.length === 0) {
    return "At least one --model is required for provider add and configure.";
  }
  const provider = parsed.provider ?? id;
  const endpoint = parsed.endpoint ?? (provider === "openai" ? "https://api.openai.com/v1" : null);
  const catalogs = parsed.catalog ?? [];
  if (catalogs.some((catalog) => !isModelCatalogId(catalog))) {
    return "Every --catalog must be a legal catalog identity.";
  }
  return {
    profileId: id,
    providerId: providerId.from(provider),
    adapterKind: adapter,
    displayName: parsed.name ?? id,
    endpoint,
    credential: null,
    organization: parsed.organization ?? null,
    project: parsed.project ?? null,
    enabledModels: models.map(modelId.from),
    catalogs,
    modelCapabilities: [],
    discovery,
    timeouts: {
      connectMs: parsed["connect-timeout"] ?? 15_000,
      requestMs: parsed["request-timeout"] ?? 120_000,
    },
  };
}
