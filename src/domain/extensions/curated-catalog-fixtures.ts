/** Catalog documents for tests: one well-formed listing per call, easily varied. */
import { createHash } from "node:crypto";

const digest = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
/** A distinct exact identity per package and version. */
export function curatedIdentity(packageId: string, version: string) {
  return {
    version: 1,
    packageId,
    packageVersion: version,
    sourceCoordinate: {
      kind: "registry",
      registry: "https://registry.example.test/",
      coordinate: packageId,
      packageVersion: version,
    },
    packageDigest: digest("package:" + packageId + "@" + version),
    manifestDigest: digest("manifest:" + packageId + "@" + version),
  };
}
export function curatedEntry(
  listingId: string,
  options: { packageId?: string; versions?: readonly string[] } = {},
): Record<string, unknown> {
  const packageId = options.packageId ?? listingId.replace("/", "-");
  return {
    listingId,
    kind: "skill",
    title: "Review helper",
    summary: "Checks pull requests before review.",
    publisher: { name: "Example Tools", url: "https://example.test/" },
    license: "MIT",
    links: { repository: "https://example.test/review" },
    tags: ["review", "git"],
    provides: ["skill", "prompt"],
    versions: (options.versions ?? ["1.0.0"]).map((version, index) => ({
      identity: curatedIdentity(packageId, version),
      compatibility: { os: [], arch: [] },
      publishedAt: 1_000 + index,
    })),
    claims: { review: { value: true, at: 900, by: "Example curators" } },
    editorial: { labels: ["featured"], rank: 1, featured: true },
  };
}
export function curatedDocument(
  entries: readonly unknown[],
  options: { source?: string; sequence?: number; extra?: Record<string, unknown> } = {},
) {
  return {
    schema: "falryn.curated-catalog",
    generation: 1,
    source: { id: options.source ?? "example", title: "Example catalog" },
    sequence: options.sequence ?? 1,
    publishedAt: 2_000,
    entries,
    ...options.extra,
  };
}
export const catalogBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
