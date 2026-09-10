import { ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { packageDocumentDigest } from "../../domain/extensions/package-data-store.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { decodePackageData } from "./package-data-repository.ts";

/** One SQLite snapshot binds each document to its installed package, without leaking row shapes. */
export function listPackageData(
  store: SqliteStorePort,
  installedOnly: boolean,
  limit: number,
  unavailable?: (packageId: string, digest: string | null) => void,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
    throw new ExtensionInputError("package-inventory-limit");
  const rows = store.read(
    "SELECT d.package_id,d.revision,d.digest,d.metadata,v.identity_digest FROM package_data d LEFT JOIN installed_packages p ON p.package_id=d.package_id LEFT JOIN package_versions v ON v.storage_id=p.storage_id WHERE $installed=0 OR v.storage_id IS NOT NULL ORDER BY d.package_id LIMIT $limit",
    { installed: installedOnly ? 1 : 0, limit: limit + 1 },
  );
  if (!rows.ok || rows.value.length > limit)
    throw new ExtensionInputError("package-inventory-unavailable");
  return rows.value.flatMap((row) => {
    try {
      const document = decodePackageData(row.metadata);
      if (
        document.packageId !== row.package_id ||
        document.revision !== row.revision ||
        packageDocumentDigest(document) !== row.digest ||
        (installedOnly && document.packageDigest !== row.identity_digest)
      )
        throw new ExtensionInputError("corrupt-package-inventory");
      return [document];
    } catch (error) {
      if (!unavailable) throw error;
      unavailable(
        String(row.package_id),
        typeof row.identity_digest === "string" ? row.identity_digest : null,
      );
      return [];
    }
  });
}
