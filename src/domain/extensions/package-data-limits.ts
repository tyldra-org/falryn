import { canonicalDigest, ExtensionInputError } from "./canonical.ts";
import { PACKAGE_DATA_LIMITS, packageDataIdentity } from "./package-data.ts";
import type { PackageDataDocument } from "./package-data-store.ts";

function fail(code: string): never {
  throw new ExtensionInputError(code);
}

export function validatePackageDataQuota(document: PackageDataDocument): void {
  if (document.records.length > PACKAGE_DATA_LIMITS.records) fail("state-record-quota-exceeded");
  const identities = new Set<string>();
  const totals = new Map<string, { count: number; bytes: number }>();
  const contributions = new Map<string, number>();
  const scopes = new Map<string, number>();
  for (const record of document.records) {
    const identity = packageDataIdentity(record.identity);
    if (identities.has(identity)) fail("duplicate-state-key");
    identities.add(identity);
    const namespace = canonicalDigest({
      contribution: record.identity.contribution,
      scope: record.identity.scope,
      owner: record.identity.owner,
      family: record.identity.family,
    });
    const total = totals.get(namespace) ?? { count: 0, bytes: 0 };
    total.count++;
    total.bytes += record.bytes;
    totals.set(namespace, total);
    const declaration = document.declarations.state.find((d) => d.id === record.identity.family);
    if (
      (!declaration && !record.tombstone) ||
      total.count > (declaration?.maxRecords ?? PACKAGE_DATA_LIMITS.records) ||
      total.bytes > PACKAGE_DATA_LIMITS.namespaceBytes
    )
      fail("state-namespace-quota-exceeded");
    const contribution = record.identity.contribution ?? "package";
    const contributionBytes = (contributions.get(contribution) ?? 0) + record.bytes;
    contributions.set(contribution, contributionBytes);
    if (contributionBytes > PACKAGE_DATA_LIMITS.contributionBytes)
      fail("state-contribution-quota-exceeded");
    const scopeBytes = (scopes.get(record.identity.scope) ?? 0) + record.bytes;
    scopes.set(record.identity.scope, scopeBytes);
    if (scopeBytes > PACKAGE_DATA_LIMITS.scopeBytes) fail("state-scope-quota-exceeded");
  }
}
