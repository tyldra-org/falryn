import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import {
  type InstalledVersion,
  installedVersionSchema,
  type PackageLifecycleStore,
  packageReceiptSchema,
} from "../../domain/extensions/lifecycle.ts";
import { PACKAGE_DATA_LIMITS } from "../../domain/extensions/package-data.ts";
import {
  encodePackageData,
  packageDocumentDigest,
} from "../../domain/extensions/package-data-store.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";
import { retainPackageArtifacts } from "./package-artifact-ownership.ts";
import { createPackageDataRepository } from "./package-data-repository.ts";

export const PACKAGE_LIFECYCLE_TABLES = [
  "installed_packages",
  "package_versions",
  "package_dependencies",
  "package_operations",
] as const;
export const MIGRATION_0014: Migration = {
  version: 14,
  name: "package-lifecycle-transactions",
  destructive: false,
  statements: [
    "CREATE TABLE installed_packages (package_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), storage_id TEXT) STRICT",
    "CREATE TABLE package_versions (sequence INTEGER PRIMARY KEY, storage_id TEXT NOT NULL UNIQUE, package_id TEXT NOT NULL, identity_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('staged','retained','deleting','deleted')), metadata TEXT NOT NULL) STRICT",
    "CREATE INDEX package_versions_by_owner ON package_versions(package_id, identity_digest, state)",
    "CREATE TABLE package_dependencies (owner TEXT NOT NULL, dependency TEXT NOT NULL, identity_digest TEXT NOT NULL, PRIMARY KEY(owner, dependency)) STRICT",
    "CREATE INDEX package_dependency_consumers ON package_dependencies(dependency)",
    "CREATE TABLE package_operations (operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL) STRICT",
  ],
};

function decode(row: Record<string, unknown> | undefined): InstalledVersion | null {
  if (row === undefined || typeof row.metadata !== "string" || row.metadata.length > 2_097_152)
    return null;
  const parsed = installedVersionSchema.safeParse({
    ...JSON.parse(row.metadata),
    state: row.state,
  });
  if (
    !parsed.success ||
    canonicalDigest(parsed.data.identity) !== parsed.data.identityDigest ||
    parsed.data.storageId !== row.storage_id
  )
    throw new Error("invalid-installed-version");
  return parsed.data;
}

/** SQLite serializes publication, dependency checks and byte ownership across processes. */
export function createPackageLifecycleRepository(store: SqliteStorePort): PackageLifecycleStore {
  const read = (sql: string, parameters: Record<string, string | number>) => {
    const result = store.read(sql, parameters);
    if (!result.ok) throw new Error("package-store-unavailable");
    return result.value;
  };
  const safely = <T>(run: () => T) => {
    try {
      return ok(run());
    } catch {
      return err({ code: "package-store-unavailable" });
    }
  };
  const repository: PackageLifecycleStore = {
    data: createPackageDataRepository(store).read,
    current(packageId) {
      return safely(() => {
        const row = read(
          "SELECT p.revision, p.storage_id, v.metadata, v.state FROM installed_packages p LEFT JOIN package_versions v ON v.storage_id = p.storage_id WHERE p.package_id = $id",
          { id: packageId },
        )[0];
        if (row === undefined) return { packageId, revision: 0, current: null };
        if (!Number.isSafeInteger(row.revision)) throw new Error("invalid-package-revision");
        const current = row.storage_id === null ? null : decode(row);
        if (row.storage_id !== null && (current === null || current.state !== "retained"))
          throw new Error("invalid-current-version");
        return { packageId, revision: Number(row.revision), current };
      });
    },
    version(packageId, digest) {
      return safely(() =>
        decode(
          read(
            "SELECT * FROM package_versions WHERE package_id = $id AND identity_digest = $digest AND state = 'retained' ORDER BY storage_id LIMIT 1",
            { id: packageId, digest },
          )[0],
        ),
      );
    },
    operation(id) {
      return safely(() => {
        const row = read(
          "SELECT fingerprint, receipt FROM package_operations WHERE operation_id = $id",
          { id },
        )[0];
        if (row === undefined) return null;
        if (
          typeof row.receipt !== "string" ||
          typeof row.fingerprint !== "string" ||
          row.receipt.length > 16_384
        )
          throw new Error("invalid-receipt");
        const receipt = packageReceiptSchema.parse(JSON.parse(row.receipt));
        if (receipt.operationId !== id) throw new Error("receipt-identity-mismatch");
        return { fingerprint: row.fingerprint, receipt };
      });
    },
    stage(version) {
      const checked = installedVersionSchema.safeParse(version);
      if (!checked.success || version.state !== "staged")
        return err({ code: "invalid-installed-version" });
      const written = store.write((sql) => {
        return sql.run(
          "INSERT INTO package_versions(storage_id, package_id, identity_digest, state, metadata) VALUES($storage, $id, $digest, 'staged', $metadata)",
          {
            storage: version.storageId,
            id: version.identity.packageId,
            digest: version.identityDigest,
            metadata: JSON.stringify(version),
          },
        ).lastInsertRowId;
      });
      return written.ok
        ? ok(written.value.value)
        : err({
            code: written.error.effect === "uncertain" ? "uncertain" : "package-store-unavailable",
          });
    },
    publish(input, signal) {
      const { expected, candidate, receipt } = input;
      let stageFailure: string | null = null;
      const written = store.write((sql) => {
        try {
          const prior = sql.all(
            "SELECT fingerprint, receipt FROM package_operations WHERE operation_id = $id",
            { id: receipt.operationId },
          )[0];
          if (prior !== undefined) return "operation-already-recorded";
          const live = sql.all(
            "SELECT revision, storage_id FROM installed_packages WHERE package_id = $id",
            { id: expected.packageId },
          )[0];
          if (
            (live?.revision ?? 0) !== expected.revision ||
            (live?.storage_id ?? null) !== (expected.current?.storageId ?? null)
          )
            return "stale-package-revision";
          const counts = sql.all(
            "SELECT state,count(*) AS count,max(sequence) AS epoch FROM package_versions WHERE package_id=$id GROUP BY state",
            { id: expected.packageId },
          );
          const retained = counts
            .filter((r) => r.state === "retained")
            .reduce((n, r) => n + Number(r.count), 0);
          const pending = counts
            .filter((r) => r.state !== "retained" && r.state !== "deleted")
            .reduce((n, r) => n + Number(r.count), 0);
          if (
            retained !== input.expectedCounts.retained ||
            pending !== input.expectedCounts.pending
          )
            return "stale-package-confirmation";
          if (Math.max(0, ...counts.map((r) => Number(r.epoch))) !== input.expectedCounts.epoch)
            return "stale-package-confirmation";
          if (candidate !== null) {
            const staged = sql.all(
              "SELECT state FROM package_versions WHERE storage_id = $storage",
              {
                storage: candidate.storageId,
              },
            )[0];
            if (staged?.state !== (input.stageBytes === undefined ? "retained" : "staged"))
              return "version-unavailable";
            if (
              sql.all(
                "SELECT owner FROM package_dependencies WHERE dependency=$id AND owner<>$id AND identity_digest<>$digest LIMIT 1",
                { id: expected.packageId, digest: candidate.identityDigest },
              ).length > 0
            )
              return "package-required";
            for (const dependency of candidate.dependencies) {
              const current = sql.all(
                "SELECT v.identity_digest FROM installed_packages p JOIN package_versions v ON v.storage_id=p.storage_id WHERE p.package_id=$id AND v.state='retained'",
                { id: dependency.id },
              )[0];
              if (current?.identity_digest !== dependency.digest) return "dependency-changed";
            }
          } else if (
            sql.all(
              "SELECT owner FROM package_dependencies WHERE dependency = $id AND owner <> $id LIMIT 1",
              { id: expected.packageId },
            ).length > 0
          )
            return "package-required";
          input.stageBytes?.();
          if (input.dataPublication !== undefined) {
            const { document, expectedRevision } = input.dataPublication;
            const data = sql.all("SELECT revision,bytes FROM package_data WHERE package_id=$id", {
              id: expected.packageId,
            })[0];
            if ((data?.revision ?? 0) !== expectedRevision)
              throw new ExtensionInputError("stale-package-data-publication");
            if (
              document.packageId !== expected.packageId ||
              document.packageDigest !==
                (candidate?.identityDigest ?? expected.current?.identityDigest) ||
              document.revision !== expectedRevision + 1
            )
              throw new ExtensionInputError("invalid-package-data-publication");
            const metadata = encodePackageData(document);
            retainPackageArtifacts(sql, document, false);
            const bytes = Buffer.byteLength(metadata);
            const used = sql.all(
              "SELECT (SELECT coalesce(sum(bytes),0) FROM package_data)+(SELECT coalesce(sum(bytes),0) FROM package_data_operations)+(SELECT coalesce(sum(bytes),0) FROM package_data_imports) AS bytes",
            )[0];
            if (
              Number(used?.bytes) - Number(data?.bytes ?? 0) + bytes >
              PACKAGE_DATA_LIMITS.globalBytes
            )
              throw new ExtensionInputError("global-package-quota-exceeded");
            sql.run(
              "INSERT INTO package_data(package_id,revision,digest,bytes,metadata) VALUES($id,$revision,$digest,$bytes,$metadata) ON CONFLICT(package_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,bytes=excluded.bytes,metadata=excluded.metadata",
              {
                id: expected.packageId,
                revision: document.revision,
                digest: packageDocumentDigest(document),
                bytes,
                metadata,
              },
            );
          }
          if (candidate !== null)
            sql.run("UPDATE package_versions SET state='retained' WHERE storage_id=$storage", {
              storage: candidate.storageId,
            });
          sql.run(
            "INSERT INTO installed_packages(package_id,revision,storage_id) VALUES($id,$revision,$storage) ON CONFLICT(package_id) DO UPDATE SET revision=excluded.revision, storage_id=excluded.storage_id",
            {
              id: expected.packageId,
              revision: receipt.revision,
              storage: candidate?.storageId ?? null,
            },
          );
          sql.run("DELETE FROM package_dependencies WHERE owner=$id", { id: expected.packageId });
          for (const dependency of candidate?.dependencies ?? [])
            sql.run(
              "INSERT INTO package_dependencies(owner,dependency,identity_digest) VALUES($owner,$dependency,$digest)",
              { owner: expected.packageId, dependency: dependency.id, digest: dependency.digest },
            );
          if (input.remove)
            sql.run(
              "UPDATE package_versions SET state='deleting' WHERE package_id=$id AND state <> 'deleted'",
              { id: expected.packageId },
            );
          sql.run(
            "INSERT INTO package_operations(operation_id,fingerprint,receipt) VALUES($id,$fingerprint,$receipt)",
            {
              id: receipt.operationId,
              fingerprint: input.fingerprint,
              receipt: JSON.stringify(receipt),
            },
          );
          return null;
        } catch (error) {
          if (error instanceof ExtensionInputError) stageFailure = error.code;
          throw error;
        }
      }, signal);
      if (!written.ok)
        return err({
          code:
            written.error.effect === "uncertain"
              ? "uncertain"
              : (stageFailure ?? written.error.code),
        });
      return written.value.value === null ? ok(receipt) : err({ code: written.value.value });
    },
    cleanup(packageId, limit, throughEpoch) {
      const written = store.write((sql) => {
        const rows = sql.all(
          "SELECT * FROM package_versions WHERE package_id=$id AND sequence <= $epoch AND state IN ('staged','deleting') ORDER BY storage_id LIMIT $limit",
          { id: packageId, limit, epoch: throughEpoch },
        );
        const versions = rows
          .map(decode)
          .filter((version): version is InstalledVersion => version !== null);
        for (const version of versions)
          sql.run("UPDATE package_versions SET state='deleting' WHERE storage_id=$storage", {
            storage: version.storageId,
          });
        return versions;
      });
      return written.ok ? ok(written.value.value) : err({ code: "cleanup-unavailable" });
    },
    removed(storageId) {
      const result = store.write((sql) => {
        sql.run(
          "UPDATE package_versions SET state='deleted' WHERE storage_id=$storage AND state='deleting'",
          { storage: storageId },
        );
      });
      return result.ok ? ok(null) : err({ code: "cleanup-unavailable" });
    },
    counts(packageId) {
      return safely(() => {
        const rows = read(
          "SELECT state, count(*) AS count,max(sequence) AS epoch FROM package_versions WHERE package_id=$id GROUP BY state",
          { id: packageId },
        );
        return {
          epoch: Math.max(0, ...rows.map((r) => Number(r.epoch))),
          retained: rows
            .filter((r) => r.state === "retained")
            .reduce((n, r) => n + Number(r.count), 0),
          pending: rows
            .filter((r) => r.state !== "retained" && r.state !== "deleted")
            .reduce((n, r) => n + Number(r.count), 0),
        };
      });
    },
  };
  return repository;
}
