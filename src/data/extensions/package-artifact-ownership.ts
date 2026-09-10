import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import {
  PACKAGE_ARTIFACT_LIMITS,
  packageArtifactReferences,
} from "../../domain/extensions/package-artifacts.ts";
import type { PackageDataDocument } from "../../domain/extensions/package-data-store.ts";
import type { SqliteStatements } from "../../domain/storage/index.ts";

/** Existing artifacts are retained by exact ownership; claims never delete shared or user-owned bytes. */
export function packageArtifactClaims(
  sql: Pick<SqliteStatements, "all">,
  document: PackageDataDocument,
  allowClaim: boolean,
) {
  const claims: { id: string; artifact: string; package: string; bytes: number }[] = [];
  for (const record of document.records) {
    if (record.tombstone) continue;
    for (const reference of packageArtifactReferences(record.value)) {
      if (claims.length >= PACKAGE_ARTIFACT_LIMITS.references)
        throw new ExtensionInputError("package-artifact-count-limit");
      const artifact = sql.all(
        "SELECT digest,byte_length,sensitivity,availability,origin FROM artifacts WHERE artifact_id=$id",
        { id: reference.artifactId },
      )[0];
      if (
        artifact?.availability !== "available" ||
        artifact.digest !== reference.digest ||
        artifact.byte_length !== reference.bytes
      )
        throw new ExtensionInputError("package-artifact-unavailable");
      if (
        artifact.origin !== "user-supplied" ||
        artifact.sensitivity === "restricted" ||
        (artifact.sensitivity !== "public" && record.sensitivity === "public")
      )
        throw new ExtensionInputError("package-artifact-sensitivity-denied");
      const identity = canonicalDigest({
        packageId: document.packageId,
        contribution: record.identity.contribution,
        scope: record.identity.scope,
        owner: record.identity.owner,
        artifactId: reference.artifactId,
      });
      const existing = sql.all("SELECT claim_id FROM package_data_artifacts WHERE claim_id=$id", {
        id: identity,
      })[0];
      if (!existing && !allowClaim)
        throw new ExtensionInputError("package-artifact-ownership-denied");
      claims.push({
        id: identity,
        artifact: reference.artifactId,
        package: document.packageId,
        bytes: reference.bytes,
      });
    }
  }
  const additions = [...new Map(claims.map((claim) => [claim.id, claim])).values()].filter(
    (claim) =>
      sql.all("SELECT claim_id FROM package_data_artifacts WHERE claim_id=$id", { id: claim.id })
        .length === 0,
  );
  const totals = sql.all(
    "SELECT count(*) AS count, coalesce(sum(bytes),0) AS global, coalesce(sum(CASE WHEN package_id=$package THEN bytes ELSE 0 END),0) AS package FROM package_data_artifacts",
    { package: document.packageId },
  )[0];
  const bytes = additions.reduce((total, claim) => total + claim.bytes, 0);
  if (Number(totals?.count) + additions.length > 16_384)
    throw new ExtensionInputError("package-artifact-retention-limit");
  if (
    Number(totals?.package) + bytes > PACKAGE_ARTIFACT_LIMITS.packageBytes ||
    Number(totals?.global) + bytes > PACKAGE_ARTIFACT_LIMITS.globalBytes
  )
    throw new ExtensionInputError("package-artifact-byte-limit");
  return additions;
}

export function retainPackageArtifacts(
  sql: SqliteStatements,
  document: PackageDataDocument,
  allowClaim: boolean,
): void {
  for (const claim of packageArtifactClaims(sql, document, allowClaim))
    sql.run(
      "INSERT INTO package_data_artifacts(claim_id,artifact_id,package_id,bytes) VALUES($id,$artifact,$package,$bytes)",
      claim,
    );
}
