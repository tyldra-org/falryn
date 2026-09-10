import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import type { PackageRequest } from "../../domain/extensions/lifecycle.ts";
import type { PackageDataDocument } from "../../domain/extensions/package-data-store.ts";

/** No namespace guess grants ownership of credentials, user files, logs, or shared artifacts. */
export function planPackageDataCleanup(
  before: PackageDataDocument,
  choice: PackageRequest["dataCleanup"],
) {
  const document = structuredClone(before);
  const removedConfiguration =
    choice?.configuration === "remove"
      ? document.layers.reduce((count, layer) => count + Object.keys(layer.values).length, 0)
      : 0;
  const credentialReferences = document.layers.reduce(
    (count, layer) =>
      count +
      Object.keys(layer.values).filter((key) =>
        document.declarations.configuration.some(
          (declaration) =>
            declaration.id === key && declaration.sensitivity === "credential-reference",
        ),
      ).length,
    0,
  );
  if (choice?.configuration === "remove") {
    document.layers = [];
    document.configurationRevision++;
  }
  let tombstoned = 0;
  document.records = document.records.map((record) => {
    const declaration = document.declarations.state.find(
      (family) =>
        family.id === record.identity.family &&
        family.contribution === record.identity.contribution,
    );
    if (
      record.tombstone ||
      choice?.state !== "declared" ||
      declaration?.cleanup !== "remove" ||
      declaration.retention === "preserve"
    )
      return record;
    tombstoned++;
    return {
      ...record,
      revision: record.revision + 1,
      tombstone: true,
      value: null,
      digest: canonicalDigest(null),
      bytes: 4,
    };
  });
  document.revision++;
  return {
    document,
    summary: {
      version: 1,
      configuration: {
        removed: removedConfiguration,
        retained: document.layers.reduce(
          (count, layer) => count + Object.keys(layer.values).length,
          0,
        ),
      },
      state: {
        tombstoned,
        retained: document.records.filter((record) => !record.tombstone).length,
      },
      credentialReferences: {
        removed: choice?.configuration === "remove" ? credentialReferences : 0,
        retained: choice?.configuration === "remove" ? 0 : credentialReferences,
      },
      credentials: "retained-by-credential-owner",
      artifacts: "retained-by-artifact-owner",
      logs: "retained-by-log-owner",
      recoveryRecords: "retained",
    },
  };
}
