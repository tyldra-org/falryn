import type { PackagePreparation } from "./prepare-package.ts";

/** Deliberately excludes raw manifests, instructions, arguments, environment, and header values. */
export function packageInspectionReport(result: PackagePreparation) {
  if (!result.ok) return { status: "failed" as const, code: result.code };
  const prepared = result.package;
  return {
    status: "inspected" as const,
    state: "declared" as const,
    packageId: prepared.identity.packageId,
    packageVersion: prepared.identity.packageVersion,
    identityDigest: prepared.identityDigest,
    packageDigest: prepared.identity.packageDigest,
    manifestDigest: prepared.identity.manifestDigest,
    fileCount: prepared.files.length,
    compatibility: prepared.compatibility,
    declaredScopes: prepared.falryn.scopes,
    contributions: prepared.contributions.map((entry) => ({
      kind: entry.identity.nativeKind,
      family: entry.family,
      authority: {
        effects: entry.authority.effects,
        permissions: entry.authority.permissions,
        rootCount: entry.authority.roots.length,
        destinationCount: entry.authority.destinations.length,
        secretReferenceCount: entry.authority.secretReferences.length,
        localDataCount: entry.authority.localData.length,
      },
      namespace: entry.identity.namespace,
      id: entry.identity.localId,
      identityDigest: entry.identityDigest,
      mode: entry.mode,
      compatibility: entry.compatibility,
      batching: entry.batching,
      disclosure:
        entry.mode === "full-user"
          ? "Activation would grant full user process access; inspection does not activate it."
          : null,
    })),
    dependencies: prepared.dependencies.ok
      ? {
          status: "resolved" as const,
          digest: prepared.dependencies.digest,
          packages: prepared.dependencies.lock.map((entry) => ({
            id: entry.id,
            packageVersion: entry.packageVersion,
            digest: entry.digest,
          })),
          degraded: prepared.dependencies.degraded,
        }
      : { status: "unresolved" as const, code: prepared.dependencies.code },
    diagnostics: prepared.diagnostics.map((entry) => ({ code: entry.code })),
    omittedDiagnostics: prepared.omittedDiagnostics,
  };
}
export type PackageInspectionReport = ReturnType<typeof packageInspectionReport>;

export function packageInspectionLines(report: PackageInspectionReport): string[] {
  if (report.status === "failed") return [`Extension inspection failed: ${report.code}`];
  return [
    `Package ${report.packageId}${report.packageVersion === null ? " (unversioned)" : `@${report.packageVersion}`}`,
    `State: declared; ${report.fileCount} files; ${report.contributions.length} contributions; nothing activated.`,
    `Host compatibility: ${report.compatibility}`,
    `Identity: ${report.identityDigest}`,
    `Package: ${report.packageDigest}`,
    `Manifest: ${report.manifestDigest}`,
    ...report.contributions.flatMap((entry) => [
      `${entry.kind} ${entry.namespace}/${entry.id}: ${entry.mode}, ${entry.compatibility}`,
      `Declared effects: ${entry.authority.effects.join(", ") || "none"}; permissions: ${entry.authority.permissions.join(", ") || "none"}.`,
      ...(entry.disclosure === null ? [] : [entry.disclosure]),
    ]),
    `Dependencies: ${report.dependencies.status}${report.dependencies.status === "unresolved" ? ` (${report.dependencies.code}; no external inventory fetched)` : ""}`,
    ...report.diagnostics.map((entry) => `Diagnostic: ${entry.code}`),
    ...(report.omittedDiagnostics === 0
      ? []
      : [`Additional diagnostics: ${report.omittedDiagnostics}`]),
  ];
}
