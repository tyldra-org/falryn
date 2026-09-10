import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { PACKAGE_DATA_LIMITS } from "../../domain/extensions/package-data.ts";
import {
  encodePackageData,
  type PackageDataDocument,
  type PackageDataStore,
  packageDataDocumentSchema,
  packageDataReceiptSchema,
  packageDocumentDigest,
} from "../../domain/extensions/package-data-store.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";
import { packageArtifactClaims, retainPackageArtifacts } from "./package-artifact-ownership.ts";

export const PACKAGE_DATA_TABLES = [
  "package_data",
  "package_data_operations",
  "package_data_imports",
  "package_data_artifacts",
] as const;
export const MIGRATION_0020: Migration = {
  version: 20,
  name: "package-configuration-and-state",
  destructive: false,
  statements: [
    "CREATE TABLE package_data (package_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, metadata TEXT NOT NULL) STRICT",
    "CREATE TABLE package_data_operations (operation_id TEXT PRIMARY KEY, package_id TEXT NOT NULL, receipt TEXT NOT NULL, recovery TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT",
    "CREATE INDEX package_data_operations_owner ON package_data_operations(package_id)",
    "CREATE TABLE package_data_imports (import_id TEXT PRIMARY KEY, owner TEXT NOT NULL, package_id TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, metadata TEXT NOT NULL) STRICT",
    "CREATE TABLE package_data_artifacts (claim_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id), package_id TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT",
    "CREATE INDEX package_data_artifacts_owner ON package_data_artifacts(package_id)",
  ],
};
export function decodePackageData(value: unknown): PackageDataDocument {
  if (typeof value !== "string" || Buffer.byteLength(value) > PACKAGE_DATA_LIMITS.packageBytes)
    throw new ExtensionInputError("corrupt-package-data");
  const document = packageDataDocumentSchema.parse(JSON.parse(value));
  for (const record of document.records) {
    if (
      record.identity.packageId !== document.packageId ||
      record.binding.packageId !== document.packageId ||
      record.digest !== canonicalDigest(record.value) ||
      record.bytes !== Buffer.byteLength(JSON.stringify(record.value))
    )
      throw new ExtensionInputError("corrupt-package-state");
  }
  return document;
}
export function createPackageDataRepository(store: SqliteStorePort): PackageDataStore {
  const safely = <T>(read: () => T) => {
    try {
      return ok(read());
    } catch (error) {
      return err({
        code: error instanceof ExtensionInputError ? error.code : "corrupt-package-data",
      });
    }
  };
  const query = (sql: string, parameters: Record<string, string>) => {
    const result = store.read(sql, parameters);
    if (!result.ok) throw new ExtensionInputError("package-store-unavailable");
    return result.value;
  };
  return {
    checkArtifacts(document, allowClaim) {
      return safely(() => {
        packageArtifactClaims(
          {
            all: (statement, bindings) => {
              const read = store.read(statement, bindings);
              if (!read.ok) throw new ExtensionInputError("package-artifact-store-unavailable");
              return read.value;
            },
          },
          document,
          allowClaim,
        );
        return null;
      });
    },
    read(packageId) {
      return safely(() => {
        const row = query("SELECT * FROM package_data WHERE package_id=$id", { id: packageId })[0];
        if (!row) return null;
        const document = decodePackageData(row.metadata);
        if (
          document.packageId !== packageId ||
          document.revision !== row.revision ||
          packageDocumentDigest(document) !== row.digest
        )
          throw new ExtensionInputError("corrupt-package-data");
        return document;
      });
    },
    receipt(operationId) {
      return safely(() => {
        const row = query("SELECT receipt FROM package_data_operations WHERE operation_id=$id", {
          id: operationId,
        })[0];
        if (!row) return null;
        if (
          typeof row.receipt !== "string" ||
          Buffer.byteLength(row.receipt) > PACKAGE_DATA_LIMITS.receiptBytes
        )
          throw new ExtensionInputError("corrupt-package-receipt");
        const receipt = packageDataReceiptSchema.parse(JSON.parse(row.receipt));
        if (receipt.operationId !== operationId)
          throw new ExtensionInputError("corrupt-package-receipt");
        return receipt;
      });
    },
    recovery(operationId) {
      return safely(() => {
        const row = query(
          "SELECT recovery,receipt FROM package_data_operations WHERE operation_id=$id",
          {
            id: operationId,
          },
        )[0];
        if (!row) return null;
        const document = decodePackageData(row.recovery);
        if (
          typeof row.receipt !== "string" ||
          Buffer.byteLength(row.receipt) > PACKAGE_DATA_LIMITS.receiptBytes
        )
          throw new ExtensionInputError("corrupt-package-receipt");
        const receipt = packageDataReceiptSchema.parse(JSON.parse(row.receipt));
        if (
          receipt.operationId !== operationId ||
          receipt.packageId !== document.packageId ||
          receipt.beforeRevision !== document.revision ||
          receipt.beforeDigest !== packageDocumentDigest(document)
        )
          throw new ExtensionInputError("corrupt-package-recovery");
        return document;
      });
    },
    commit(input, signal) {
      const prepared = safely(() => ({
        after: encodePackageData(input.after),
        before: encodePackageData(input.before),
        receipt: JSON.stringify(packageDataReceiptSchema.parse(input.receipt)),
      }));
      if (!prepared.ok) return prepared;
      if (Buffer.byteLength(prepared.value.receipt) > PACKAGE_DATA_LIMITS.receiptBytes)
        return err({ code: "package-receipt-quota-exceeded" });
      let stageFailure: string | null = null;
      const written = store.write((sql) => {
        try {
          const fail = (code: string): never => {
            throw new ExtensionInputError(code);
          };
          if (signal?.aborted) return "cancelled";
          if (!input.authorize()) return "revoked-package-data";
          const binding = input.binding;
          const installed = sql.all(
            "SELECT p.revision,v.identity_digest FROM installed_packages p JOIN package_versions v ON p.storage_id=v.storage_id WHERE p.package_id=$id AND v.state='retained'",
            { id: binding.packageId },
          )[0];
          if (
            installed?.revision !== binding.packageRevision ||
            installed.identity_digest !== binding.packageDigest
          )
            return "stale-package-generation";
          const current = sql.all(
            "SELECT revision,digest,bytes FROM package_data WHERE package_id=$id",
            { id: binding.packageId },
          )[0];
          if (
            (current?.revision ?? 0) !== input.before.revision ||
            (current && current.digest !== packageDocumentDigest(input.before))
          )
            return "stale-data-revision";
          if (
            input.after.packageId !== binding.packageId ||
            input.after.packageDigest !== binding.packageDigest ||
            input.after.revision !==
              input.before.revision + (input.receipt.status === "unchanged" ? 0 : 1) ||
            (input.receipt.status === "unchanged" &&
              packageDocumentDigest(input.after) !== packageDocumentDigest(input.before))
          )
            return "invalid-data-publication";
          if (
            sql.all("SELECT operation_id FROM package_data_operations WHERE operation_id=$id", {
              id: input.receipt.operationId,
            }).length
          )
            return "operation-already-recorded";
          const count = sql.all(
            "SELECT count(*) AS count FROM package_data_operations WHERE package_id=$id",
            { id: binding.packageId },
          )[0];
          if (Number(count?.count) >= PACKAGE_DATA_LIMITS.retainedOperations)
            return "recovery-quota-exceeded";
          const bytes = Buffer.byteLength(prepared.value.after);
          const recoveryBytes =
            Buffer.byteLength(prepared.value.before) + Buffer.byteLength(prepared.value.receipt);
          const global = sql.all(
            "SELECT (SELECT coalesce(sum(bytes),0) FROM package_data)+(SELECT coalesce(sum(bytes),0) FROM package_data_operations)+(SELECT coalesce(sum(bytes),0) FROM package_data_imports) AS bytes",
          )[0];
          if (
            Number(global?.bytes) - Number(current?.bytes ?? 0) + bytes + recoveryBytes >
            PACKAGE_DATA_LIMITS.globalBytes
          )
            return "global-package-quota-exceeded";
          if (
            input.receipt.afterDigest !== packageDocumentDigest(input.after) ||
            input.receipt.beforeDigest !== packageDocumentDigest(input.before)
          )
            fail("invalid-data-receipt");
          retainPackageArtifacts(sql, input.after, input.allowArtifactClaim === true);
          if (input.receipt.status !== "unchanged")
            sql.run(
              "INSERT INTO package_data(package_id,revision,digest,bytes,metadata) VALUES($id,$revision,$digest,$bytes,$metadata) ON CONFLICT(package_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,bytes=excluded.bytes,metadata=excluded.metadata",
              {
                id: binding.packageId,
                revision: input.after.revision,
                digest: input.receipt.afterDigest,
                bytes,
                metadata: prepared.value.after,
              },
            );
          sql.run(
            "INSERT INTO package_data_operations(operation_id,package_id,receipt,recovery,bytes) VALUES($op,$id,$receipt,$recovery,$bytes)",
            {
              op: input.receipt.operationId,
              id: binding.packageId,
              receipt: prepared.value.receipt,
              recovery: prepared.value.before,
              bytes: recoveryBytes,
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
      return written.value.value === null ? ok(input.receipt) : err({ code: written.value.value });
    },
  };
}
