/**
 * Marketplace catalog sources (#153). A marketplace is one optional, user-configured
 * HTTPS location that publishes a #165 curated catalog document. Configuring one grants
 * nothing: only an explicit refresh contacts it, and what it returns is ingested exactly
 * like a local catalog. Freshness is a dated fact about the last successful fetch, never
 * a claim that its withdrawals or advisories are current.
 */
import { z } from "zod";
import type { CredentialReference } from "../configuration/configuration.ts";
import { type CatalogOrigin, CURATED_LIMITS } from "./curated-catalog.ts";
import { credentialEnvironmentSchema, credentialSettingSchema } from "./mcp.ts";

export const MARKETPLACES_KEY = "tools.marketplaces";
export const MARKETPLACE_LIMITS = Object.freeze({
  sources: 16,
  /** One refresh request, including connection and the whole bounded response. */
  requestMs: 30_000,
  responseBytes: CURATED_LIMITS.documentBytes,
  maxAgeHours: 720,
});
export const DEFAULT_MARKETPLACE_MAX_AGE_HOURS = 24;

/** Absolute https only: no credentials, query or fragment in the configured location. */
const location = z
  .string()
  .max(CURATED_LIMITS.urlLength)
  .refine((value) => {
    if (/\s/u.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }, "marketplace-url-invalid");

export const marketplaceSourceSchema = z
  .strictObject({
    /** Must equal the catalog's source id; a document naming another source is refused. */
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
    url: location,
    enabled: z.boolean().default(true),
    maxAgeHours: z
      .int()
      .min(1)
      .max(MARKETPLACE_LIMITS.maxAgeHours)
      .default(DEFAULT_MARKETPLACE_MAX_AGE_HOURS),
    credential: credentialSettingSchema.optional(),
    credentialEnvironment: credentialEnvironmentSchema.optional(),
  })
  .refine(
    (source) => source.credential === undefined || source.credentialEnvironment === undefined,
    "credential and credentialEnvironment are exclusive",
  );
export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;

export const marketplaceConfigurationSchema = z
  .strictObject({ sources: z.array(marketplaceSourceSchema).max(MARKETPLACE_LIMITS.sources) })
  .refine(
    ({ sources }) => new Set(sources.map((source) => source.id)).size === sources.length,
    "duplicate marketplace identity",
  );
export type MarketplaceConfiguration = z.infer<typeof marketplaceConfigurationSchema>;

/** The consumer is the marketplace itself, so no other owner can resolve its credential. */
export function marketplaceCredentialReference(
  source: MarketplaceSource,
): CredentialReference | null {
  const consumer = `marketplace:${source.id}`;
  if (source.credential !== undefined) return { ...source.credential, consumer };
  if (source.credentialEnvironment !== undefined)
    return {
      storeKind: "environment",
      locator: source.credentialEnvironment,
      consumer,
      accountLabel: null,
    };
  return null;
}

/**
 * How current one stored catalog is, from its origin and the configured source.
 * local: a file import, which makes no freshness claim. unconfigured: fetched from a
 * location that is no longer configured for this source. disabled: its marketplace is
 * configured but switched off, so its listings are withheld. unknown: configuration
 * could not be read. Every marketplace state keeps the date it was fetched.
 */
export type CatalogFreshness =
  | { readonly state: "local" }
  | {
      readonly state: "fresh" | "stale";
      readonly fetchedAt: number;
      readonly maxAgeHours: number;
    }
  | { readonly state: "unconfigured" | "disabled" | "unknown"; readonly fetchedAt: number };

export function catalogFreshness(
  origin: CatalogOrigin,
  sourceId: string,
  sources: readonly MarketplaceSource[] | null,
  now: number,
): CatalogFreshness {
  if (origin.kind === "file") return { state: "local" };
  const { fetchedAt } = origin;
  if (sources === null) return { state: "unknown", fetchedAt };
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (source === undefined || source.url !== origin.url)
    return { state: "unconfigured", fetchedAt };
  if (!source.enabled) return { state: "disabled", fetchedAt };
  const fresh = now - fetchedAt <= source.maxAgeHours * 3_600_000;
  return { state: fresh ? "fresh" : "stale", fetchedAt, maxAgeHours: source.maxAgeHours };
}
