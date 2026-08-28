/**
 * Declared provider adapter kinds and discovery policies.
 *
 * Concrete vendor SDKs attach as leaf adapters named by these kinds.
 * Compatibility is never inferred from a URL label alone.
 */

export const PROVIDER_ADAPTER_KINDS = [
  "deterministic",
  "openai",
  "anthropic",
  "google",
  "custom",
] as const;

export type ProviderAdapterKind = (typeof PROVIDER_ADAPTER_KINDS)[number];

export function isProviderAdapterKind(value: unknown): value is ProviderAdapterKind {
  return typeof value === "string" && (PROVIDER_ADAPTER_KINDS as readonly string[]).includes(value);
}

export const DISCOVERY_POLICIES = ["static", "remote"] as const;

export type DiscoveryPolicy = (typeof DISCOVERY_POLICIES)[number];

export function isDiscoveryPolicy(value: unknown): value is DiscoveryPolicy {
  return typeof value === "string" && (DISCOVERY_POLICIES as readonly string[]).includes(value);
}
