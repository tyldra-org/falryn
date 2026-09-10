import { ExtensionInputError } from "./canonical.ts";
import {
  type ContributionConfigurationBinding,
  PACKAGE_DATA_LIMITS,
  type PackageStateRecord,
} from "./package-data.ts";
import type { PackageDataDocument } from "./package-data-store.ts";

/** A declared copy creates fresh record revisions and cannot revive a destination tombstone. */
export function copyPackageSessionState(
  document: PackageDataDocument,
  source: string,
  destination: string,
  bind: (record: PackageStateRecord) => ContributionConfigurationBinding,
  now: number,
): string[] {
  if (
    source === destination ||
    document.records.some(
      (record) => record.identity.scope === "session" && record.identity.owner === destination,
    )
  )
    throw new ExtensionInputError("fork-destination-exists");
  const copied = document.records.filter(
    (record) =>
      record.identity.scope === "session" &&
      record.identity.owner === source &&
      !record.tombstone &&
      document.declarations.state.some(
        (declaration) =>
          declaration.id === record.identity.family &&
          declaration.contribution === record.identity.contribution &&
          declaration.fork === "copy",
      ),
  );
  if (document.records.length + copied.length > PACKAGE_DATA_LIMITS.records)
    throw new ExtensionInputError("state-record-quota-exceeded");
  document.records.push(
    ...copied.map((record) => ({
      ...record,
      identity: { ...record.identity, owner: destination },
      binding: bind(record),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })),
  );
  return copied.map((record) => record.identity.key);
}
