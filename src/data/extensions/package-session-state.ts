import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { PACKAGE_DATA_LIMITS } from "../../domain/extensions/package-data.ts";
import { validatePackageDataQuota } from "../../domain/extensions/package-data-limits.ts";
import {
  encodePackageData,
  packageDocumentDigest,
} from "../../domain/extensions/package-data-store.ts";
import { copyPackageSessionState } from "../../domain/extensions/package-state-lifetime.ts";
import type { SessionRecord } from "../../domain/sessions/records.ts";
import type { SqliteStatements } from "../../domain/storage/index.ts";
import { packageArtifactClaims, retainPackageArtifacts } from "./package-artifact-ownership.ts";
import { decodePackageData } from "./package-data-repository.ts";

/** Runs in the session-fork transaction. Imported data is never selected. */
export function forkPackageSessionState(
  sql: SqliteStatements,
  source: SessionRecord,
  destination: SessionRecord,
): void {
  const rows = sql.all(
    "SELECT d.metadata,d.bytes,d.digest,d.revision FROM package_data d JOIN installed_packages p ON p.package_id=d.package_id JOIN package_versions v ON v.storage_id=p.storage_id WHERE v.identity_digest=json_extract(d.metadata,'$.packageDigest') LIMIT 257",
  );
  if (rows.length > 256) throw new ExtensionInputError("package-fork-inventory-limit");
  let addedBytes = 0;
  for (const row of rows) {
    const document = decodePackageData(row.metadata);
    if (document.revision !== row.revision || packageDocumentDigest(document) !== row.digest)
      throw new ExtensionInputError("corrupt-package-data");
    packageArtifactClaims(sql, document, false);
    const copied = copyPackageSessionState(
      document,
      source.sessionId,
      destination.sessionId,
      (record) => ({
        ...record.binding,
        sessionGeneration: canonicalDigest({
          session: destination.sessionId,
          roots: destination.extensionCatalog?.workspaceBinding ?? null,
          configuration: destination.configurationGeneration,
        }),
      }),
      Date.parse(destination.startedAt),
    );
    if (copied.length === 0) continue;
    validatePackageDataQuota(document);
    document.revision++;
    const metadata = encodePackageData(document);
    const bytes = Buffer.byteLength(metadata);
    addedBytes += bytes - Number(row.bytes);
    retainPackageArtifacts(sql, document, true);
    sql.run(
      "UPDATE package_data SET revision=$revision,digest=$digest,bytes=$bytes,metadata=$metadata WHERE package_id=$id",
      {
        id: document.packageId,
        revision: document.revision,
        digest: packageDocumentDigest(document),
        bytes,
        metadata,
      },
    );
  }
  const total = sql.all(
    "SELECT (SELECT coalesce(sum(bytes),0) FROM package_data)+(SELECT coalesce(sum(bytes),0) FROM package_data_operations)+(SELECT coalesce(sum(bytes),0) FROM package_data_imports) AS bytes",
  )[0];
  if (addedBytes > 0 && Number(total?.bytes) > PACKAGE_DATA_LIMITS.globalBytes)
    throw new ExtensionInputError("global-package-quota-exceeded");
}

/** Session closure applies declared cleanup while keeping tombstones and retained recovery roots. */
export function closePackageSessionState(
  sql: SqliteStatements,
  session: string,
  now: number,
): void {
  const rows = sql.all(
    "SELECT metadata,digest,revision FROM package_data WHERE EXISTS (SELECT 1 FROM json_each(metadata,'$.records') r WHERE json_extract(r.value,'$.identity.scope')='session' AND json_extract(r.value,'$.identity.owner')=$session) LIMIT 257",
    { session },
  );
  if (rows.length > 256) throw new ExtensionInputError("package-cleanup-inventory-limit");
  for (const row of rows) {
    const document = decodePackageData(row.metadata);
    if (document.revision !== row.revision || packageDocumentDigest(document) !== row.digest)
      throw new ExtensionInputError("corrupt-package-data");
    let changed = false;
    document.records = document.records.map((record) => {
      const declaration = document.declarations.state.find(
        (family) =>
          family.id === record.identity.family &&
          family.contribution === record.identity.contribution,
      );
      if (
        record.tombstone ||
        record.identity.scope !== "session" ||
        record.identity.owner !== session ||
        record.retention !== "session" ||
        declaration?.cleanup !== "remove"
      )
        return record;
      changed = true;
      return {
        ...record,
        revision: record.revision + 1,
        value: null,
        digest: canonicalDigest(null),
        bytes: 4,
        tombstone: true,
        updatedAt: now,
      };
    });
    if (!changed) continue;
    document.revision++;
    const metadata = encodePackageData(document);
    sql.run(
      "UPDATE package_data SET revision=$revision,digest=$digest,bytes=$bytes,metadata=$metadata WHERE package_id=$id",
      {
        id: document.packageId,
        revision: document.revision,
        digest: packageDocumentDigest(document),
        bytes: Buffer.byteLength(metadata),
        metadata,
      },
    );
  }
}
