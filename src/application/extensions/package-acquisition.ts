/**
 * Acquire one listed package version for install or update (#1210). The listing is
 * re-read and gated exactly as inspection gates it, its archive is downloaded and read
 * into memory, and the result is an in-memory package source that records the listed
 * source coordinate. The lifecycle then refuses any prepared identity but the listed one.
 */
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import {
  type MarketplaceSource,
  marketplaceCredentialReference,
} from "../../domain/extensions/marketplace.ts";
import type { PackageListingRequest } from "../../domain/extensions/package-acquisition.ts";
import { readPackageArchive } from "../../domain/extensions/package-archive.ts";
import type { PackageSource } from "../../domain/extensions/package-source.ts";
import type { createCuratedCatalogs } from "./curated-catalogs.ts";
import type { PackageDownloadPort } from "./package-download-port.ts";

export type PackageAcquisition =
  | {
      readonly ok: true;
      readonly source: PackageSource;
      readonly expectedIdentityDigest: string;
      readonly facts: {
        readonly listing: PackageListingRequest;
        readonly download: string;
        readonly bytes: number;
        readonly redirects: number;
      };
    }
  | { readonly ok: false; readonly code: string };

export async function acquireListedPackage(
  ports: {
    readonly catalogs: Pick<ReturnType<typeof createCuratedCatalogs>, "inspect">;
    readonly marketplaces: () => readonly MarketplaceSource[] | null;
    readonly download: PackageDownloadPort;
  },
  listing: PackageListingRequest,
  signal: AbortSignal,
): Promise<PackageAcquisition> {
  const inspected = ports.catalogs.inspect(listing);
  if (inspected.status !== "inspected") return { ok: false, code: inspected.code };
  const { install, version, source } = inspected;
  if (install.status !== "available") return { ok: false, code: install.code };
  let credential: Parameters<PackageDownloadPort["download"]>[0]["credential"] = null;
  if (install.credential === "marketplace" && source.origin?.kind === "marketplace") {
    const url = source.origin.url;
    const configured = (ports.marketplaces() ?? []).find(
      (candidate) => candidate.id === listing.sourceId && candidate.url === url,
    );
    const reference = configured === undefined ? null : marketplaceCredentialReference(configured);
    if (reference !== null) credential = { origin: new URL(url).origin, reference };
  }
  const received = await ports.download.download({ url: install.download, credential }, signal);
  if (received.kind === "failed") return { ok: false, code: received.code };
  const coordinate = version.identity.sourceCoordinate;
  // An archive coordinate names its exact bytes; check them before reading anything.
  if (coordinate.kind === "archive" && bytesDigest(received.bytes) !== coordinate.digest)
    return { ok: false, code: "archive-digest-mismatch" };
  const files = readPackageArchive(received.bytes);
  if (!files.ok) return { ok: false, code: files.error };
  const snapshot = {
    sourceId: `listing:${listing.sourceId}/${listing.listingId}@${listing.packageVersion}`,
    sourceCoordinate: coordinate,
    files: files.value,
    diagnostics: [],
    omittedDiagnostics: 0,
  };
  return {
    ok: true,
    source: { read: async () => snapshot },
    expectedIdentityDigest: install.identityDigest,
    facts: {
      listing,
      download: received.url,
      bytes: received.bytes.length,
      redirects: received.redirects,
    },
  };
}
