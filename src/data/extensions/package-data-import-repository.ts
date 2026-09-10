import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { PACKAGE_DATA_LIMITS } from "../../domain/extensions/package-data.ts";
import {
  type PackageDataImportStore,
  type PackageDataReplay,
  packageDataBundleSchema,
} from "../../domain/extensions/package-data-transfer.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";

/** Historical projections carry identities and digests only. No current package lookup or migration occurs. */
export function replayPackageData(store: SqliteStorePort, session: string) {
  const rows = store.read(
    "SELECT import_id,owner FROM package_data_imports WHERE EXISTS (SELECT 1 FROM json_each(metadata,'$.state') s WHERE json_extract(s.value,'$.record.identity.scope')='session' AND json_extract(s.value,'$.record.identity.owner')=$session) ORDER BY import_id LIMIT 65",
    { session },
  );
  if (!rows.ok || rows.value.length > 64) return err({ code: "inert-replay-unavailable" });
  const repository = createPackageDataImportRepository(store);
  const projections: PackageDataReplay[] = [];
  for (const row of rows.value) {
    const loaded = repository.read(String(row.import_id), String(row.owner));
    if (!loaded.ok || !loaded.value) return err({ code: "inert-replay-unavailable" });
    const bundle = loaded.value.bundle;
    const selected = bundle.state.filter(
      (entry) =>
        entry.record.identity.scope === "session" && entry.record.identity.owner === session,
    );
    projections.push({
      importId: loaded.value.receipt.importId,
      exportId: bundle.exportId,
      packageId: bundle.packageId,
      records: selected.slice(0, 128).map(({ id, record }) => ({
        source: id,
        identity: record.identity,
        binding: record.binding,
        schemaVersion: record.schemaVersion,
        revision: record.revision,
        digest: record.digest,
      })),
      omitted: Math.max(0, selected.length - 128) + bundle.omissions.length,
    });
  }
  return ok(projections);
}

export function createPackageDataImportRepository(store: SqliteStorePort): PackageDataImportStore {
  return {
    read(importId, owner) {
      const rows = store.read(
        "SELECT metadata,digest FROM package_data_imports WHERE import_id=$id AND owner=$owner",
        { id: importId, owner },
      );
      if (!rows.ok) return err({ code: "inert-data-unavailable" });
      const row = rows.value[0];
      if (!row) return ok(null);
      try {
        if (
          typeof row.metadata !== "string" ||
          Buffer.byteLength(row.metadata) > PACKAGE_DATA_LIMITS.packageBytes ||
          bytesDigest(row.metadata) !== row.digest
        )
          return err({ code: "corrupt-inert-data" });
        const bundle = packageDataBundleSchema.parse(JSON.parse(row.metadata));
        return ok({
          bundle,
          receipt: {
            importId,
            digest: String(row.digest),
            packageId: bundle.packageId,
            records: bundle.configuration.length + bundle.state.length,
          },
        });
      } catch {
        return err({ code: "corrupt-inert-data" });
      }
    },
    save(importId, owner, bundle, digest, signal) {
      const metadata = JSON.stringify(packageDataBundleSchema.parse(bundle));
      const bytes = Buffer.byteLength(metadata);
      if (bytes > PACKAGE_DATA_LIMITS.packageBytes || bytesDigest(metadata) !== digest)
        return err({ code: "invalid-inert-data" });
      const receipt = {
        importId,
        digest,
        packageId: bundle.packageId,
        records: bundle.configuration.length + bundle.state.length,
      };
      const saved = store.write((sql) => {
        if (signal?.aborted) return "cancelled";
        const existing = sql.all(
          "SELECT owner,digest FROM package_data_imports WHERE import_id=$id",
          { id: importId },
        )[0];
        if (existing)
          return existing.owner === owner && existing.digest === digest ? null : "import-id-reused";
        const used = sql.all(
          "SELECT (SELECT coalesce(sum(bytes),0) FROM package_data)+(SELECT coalesce(sum(bytes),0) FROM package_data_operations)+(SELECT coalesce(sum(bytes),0) FROM package_data_imports) AS bytes, (SELECT count(*) FROM package_data_imports) AS count",
        )[0];
        if (
          Number(used?.bytes) + bytes > PACKAGE_DATA_LIMITS.globalBytes ||
          Number(used?.count) >= PACKAGE_DATA_LIMITS.retainedOperations
        )
          return "inert-data-quota";
        sql.run(
          "INSERT INTO package_data_imports(import_id,owner,package_id,digest,bytes,metadata) VALUES($id,$owner,$package,$digest,$bytes,$metadata)",
          { id: importId, owner, package: bundle.packageId, digest, bytes, metadata },
        );
        return null;
      }, signal);
      if (!saved.ok)
        return err({
          code: saved.error.effect === "uncertain" ? "uncertain" : "inert-data-write-failed",
        });
      return saved.value.value === null ? ok(receipt) : err({ code: saved.value.value });
    },
  };
}
