/**
 * Marketplace catalog transport (#153): one bounded GET of exactly the configured
 * location through governed, address-pinned HTTPS. Redirects are refused rather than
 * followed, so a credential only ever reaches its configured origin. Compressed or
 * non-JSON bodies are refused before parsing; the bytes are only returned for ingestion.
 */
import type {
  MarketplaceFetch,
  MarketplaceFetchPort,
} from "../../application/extensions/marketplace-port.ts";
import {
  MARKETPLACE_LIMITS,
  marketplaceCredentialReference,
} from "../../domain/extensions/marketplace.ts";
import type { SecretResolverPort } from "../../domain/security/credential.ts";
import {
  type EgressOptions,
  type PinnedResponse,
  pinnedHttpsRequest,
  pinPublicDestination,
  ResponseTooLarge,
} from "../security/pinned-https.ts";

function header(response: PinnedResponse, name: string): string {
  const value = response.headers[name];
  return (Array.isArray(value) ? value.join(",") : (value ?? "")).trim().toLowerCase();
}

export function createHostMarketplaceHttp(ports: {
  readonly credentials: SecretResolverPort;
  readonly now: () => number;
  readonly egress?: EgressOptions;
}): MarketplaceFetchPort {
  return {
    async fetch(source, callerSignal): Promise<MarketplaceFetch> {
      const deadline = AbortSignal.timeout(MARKETPLACE_LIMITS.requestMs);
      const signal = AbortSignal.any([callerSignal, deadline]);
      const stopped = (): MarketplaceFetch => ({
        kind: "failed",
        code: callerSignal.aborted ? "marketplace-cancelled" : "marketplace-timed-out",
      });
      if (signal.aborted) return stopped();
      const url = new URL(source.url);
      if (url.protocol !== "https:")
        return { kind: "failed", code: "marketplace-destination-unresolved" };
      let authorization: string | null = null;
      const reference = marketplaceCredentialReference(source);
      if (reference !== null) {
        const resolved = await ports.credentials.resolve(
          { reference, consumer: reference.consumer },
          (secret) => secret,
          { signal },
        );
        if (resolved.kind !== "resolved")
          return signal.aborted
            ? stopped()
            : { kind: "failed", code: "marketplace-credential-unavailable" };
        authorization = `Bearer ${resolved.value}`;
      }
      const destination = await pinPublicDestination(url, ports.egress);
      if (signal.aborted) return stopped();
      if (destination.kind === "unresolved")
        return { kind: "failed", code: "marketplace-destination-unresolved" };
      if (destination.kind === "private")
        return { kind: "failed", code: "marketplace-destination-private" };
      let response: PinnedResponse;
      try {
        response = await pinnedHttpsRequest({
          url,
          path: url.pathname,
          destination,
          method: "GET",
          headers: {
            accept: "application/json",
            "accept-encoding": "identity",
            ...(authorization === null ? {} : { authorization }),
          },
          body: null,
          responseBytes: MARKETPLACE_LIMITS.responseBytes,
          ca: ports.egress?.ca,
          signal,
        });
      } catch (error) {
        if (signal.aborted) return stopped();
        if (error instanceof ResponseTooLarge)
          return { kind: "failed", code: "marketplace-response-too-large" };
        return { kind: "failed", code: "marketplace-transport-failed" };
      }
      if (response.status >= 300 && response.status < 400)
        return { kind: "failed", code: "marketplace-redirect-refused" };
      if (response.status === 401 || response.status === 403)
        return { kind: "failed", code: "marketplace-unauthorized" };
      if (response.status !== 200) return { kind: "failed", code: "marketplace-http-status" };
      const encoding = header(response, "content-encoding");
      const media = header(response, "content-type").split(";")[0]?.trim();
      if ((encoding !== "" && encoding !== "identity") || media !== "application/json")
        return { kind: "failed", code: "marketplace-content-type" };
      return { kind: "received", bytes: response.bytes, fetchedAt: ports.now() };
    },
  };
}
