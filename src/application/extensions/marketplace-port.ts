import type { MarketplaceSource } from "../../domain/extensions/marketplace.ts";

/** Why one marketplace could not be read; a cached catalog is never changed by any of them. */
export const MARKETPLACE_FETCH_FAILURES = [
  "marketplace-cancelled",
  "marketplace-timed-out",
  "marketplace-resource-admission-denied",
  "marketplace-credential-unavailable",
  "marketplace-destination-unresolved",
  "marketplace-destination-private",
  "marketplace-transport-failed",
  "marketplace-redirect-refused",
  "marketplace-unauthorized",
  "marketplace-http-status",
  "marketplace-content-type",
  "marketplace-response-too-large",
] as const;
export type MarketplaceFetchFailure = (typeof MARKETPLACE_FETCH_FAILURES)[number];

export type MarketplaceFetch =
  | { readonly kind: "received"; readonly bytes: Uint8Array; readonly fetchedAt: number }
  | { readonly kind: "failed"; readonly code: MarketplaceFetchFailure };

/** Reads one configured marketplace's catalog document. Reading grants and writes nothing. */
export interface MarketplaceFetchPort {
  fetch(source: MarketplaceSource, signal: AbortSignal): Promise<MarketplaceFetch>;
}
