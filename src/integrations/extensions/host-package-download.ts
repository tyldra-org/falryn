/**
 * Package archive download (#1210): a bounded GET that follows at most three redirects.
 * Every hop must be https and is re-resolved and pinned to public addresses. The
 * credential is attached only while the hop's origin is the credential's own origin, so
 * a redirect elsewhere never receives it. Integrity comes from the listed identity, which
 * the caller verifies after reading the archive.
 */
import type {
  PackageDownload,
  PackageDownloadPort,
} from "../../application/extensions/package-download-port.ts";
import {
  PACKAGE_DOWNLOAD_LIMITS,
  type PackageDownloadFailure,
} from "../../domain/extensions/package-acquisition.ts";
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
  return (Array.isArray(value) ? value.join(",") : (value ?? "")).trim();
}

export function createHostPackageDownload(ports: {
  readonly credentials: SecretResolverPort;
  readonly egress?: EgressOptions;
}): PackageDownloadPort {
  return {
    async download(request, callerSignal) {
      const deadline = AbortSignal.timeout(PACKAGE_DOWNLOAD_LIMITS.totalMs);
      const signal = AbortSignal.any([callerSignal, deadline]);
      const fail = (code: PackageDownloadFailure): PackageDownload => ({
        kind: "failed",
        code: signal.aborted
          ? callerSignal.aborted
            ? "package-download-cancelled"
            : "package-download-timed-out"
          : code,
      });
      let authorization: string | null | undefined;
      let current: URL;
      try {
        current = new URL(request.url);
      } catch {
        return fail("package-download-unresolved");
      }
      for (let hop = 0; ; hop++) {
        if (signal.aborted) return fail("package-download-cancelled");
        if (current.protocol !== "https:" || current.username !== "" || current.password !== "")
          return fail("package-download-insecure-redirect");
        let credentialHeader: string | null = null;
        if (request.credential !== null && current.origin === request.credential.origin) {
          if (authorization === undefined) {
            const reference = request.credential.reference;
            const resolved = await ports.credentials.resolve(
              { reference, consumer: reference.consumer },
              (secret) => secret,
              { signal },
            );
            if (resolved.kind !== "resolved")
              return fail("package-download-credential-unavailable");
            authorization = `Bearer ${resolved.value}`;
          }
          credentialHeader = authorization;
        }
        const destination = await pinPublicDestination(current, ports.egress);
        if (destination.kind === "unresolved") return fail("package-download-unresolved");
        if (destination.kind === "private") return fail("package-download-private");
        let response: PinnedResponse;
        try {
          response = await pinnedHttpsRequest({
            url: current,
            path: current.pathname + current.search,
            destination,
            method: "GET",
            headers: {
              accept: "application/gzip, application/octet-stream",
              "accept-encoding": "identity",
              ...(credentialHeader === null ? {} : { authorization: credentialHeader }),
            },
            body: null,
            responseBytes: PACKAGE_DOWNLOAD_LIMITS.compressedBytes,
            ca: ports.egress?.ca,
            signal,
          });
        } catch (error) {
          return fail(
            error instanceof ResponseTooLarge
              ? "package-download-too-large"
              : "package-download-transport-failed",
          );
        }
        if (response.status >= 300 && response.status < 400) {
          const location = header(response, "location");
          if (location === "") return fail("package-download-http-status");
          if (hop >= PACKAGE_DOWNLOAD_LIMITS.redirects)
            return fail("package-download-redirect-limit");
          try {
            current = new URL(location, current);
          } catch {
            return fail("package-download-http-status");
          }
          continue;
        }
        if (response.status === 401 || response.status === 403)
          return fail("package-download-unauthorized");
        if (response.status !== 200) return fail("package-download-http-status");
        const encoding = header(response, "content-encoding").toLowerCase();
        if (encoding !== "" && encoding !== "identity") return fail("package-download-encoding");
        return { kind: "received", bytes: response.bytes, url: current.href, redirects: hop };
      }
    },
  };
}
