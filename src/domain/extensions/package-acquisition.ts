/**
 * Package acquisition from marketplace listings (#1210). A listed version names an exact
 * PackageIdentityV1; its source coordinate says where the package bytes are published.
 * This owner derives that location; the bytes must then reproduce the listed identity.
 */
import { z } from "zod";
import type { PackageIdentityV1 } from "./identity.ts";

export const PACKAGE_DOWNLOAD_LIMITS = Object.freeze({
  redirects: 3,
  /** All hops together, including connection and the bounded body. */
  totalMs: 120_000,
  compressedBytes: 67_108_864,
});

/** The exact listed version an install or update acquires. */
export const packageListingRequestSchema = z.strictObject({
  sourceId: z.string().min(1).max(64),
  listingId: z.string().min(1).max(129),
  packageVersion: z.string().min(1).max(128),
});
export type PackageListingRequest = z.infer<typeof packageListingRequestSchema>;

export const PACKAGE_DOWNLOAD_FAILURES = [
  "package-download-private",
  "package-download-unresolved",
  "package-download-redirect-limit",
  "package-download-insecure-redirect",
  "package-download-unauthorized",
  "package-download-http-status",
  "package-download-encoding",
  "package-download-too-large",
  "package-download-timed-out",
  "package-download-cancelled",
  "package-download-transport-failed",
  "package-download-admission-denied",
  "package-download-credential-unavailable",
] as const;
export type PackageDownloadFailure = (typeof PACKAGE_DOWNLOAD_FAILURES)[number];

export type AcquisitionLocation =
  | {
      readonly ok: true;
      readonly url: string;
      /** SHA-256 the downloaded bytes must have; only archive coordinates declare one. */
      readonly archiveDigest: string | null;
    }
  | {
      readonly ok: false;
      readonly code: "acquisition-source-unsupported" | "acquisition-insecure-origin";
    };

/**
 * Where a listed identity's package archive is published.
 * - archive: exactly its origin, with the archive digest it declares.
 * - registry (Falryn registry layout v1):
 *   <registry>/<encodeURIComponent(coordinate)>/<encodeURIComponent(packageVersion)>/package.tgz
 * Git, local and built-in coordinates are not acquired here.
 */
export function acquisitionLocation(identity: PackageIdentityV1): AcquisitionLocation {
  const coordinate = identity.sourceCoordinate;
  let url: URL;
  if (coordinate.kind === "archive") url = new URL(coordinate.origin);
  else if (coordinate.kind === "registry") {
    const base = coordinate.registry.endsWith("/")
      ? coordinate.registry
      : `${coordinate.registry}/`;
    url = new URL(
      `${encodeURIComponent(coordinate.coordinate)}/${encodeURIComponent(coordinate.packageVersion)}/package.tgz`,
      base,
    );
  } else return { ok: false, code: "acquisition-source-unsupported" };
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return { ok: false, code: "acquisition-insecure-origin" };
  return {
    ok: true,
    url: url.href,
    archiveDigest: coordinate.kind === "archive" ? coordinate.digest : null,
  };
}
