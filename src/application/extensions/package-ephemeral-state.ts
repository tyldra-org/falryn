import { PACKAGE_DATA_LIMITS } from "../../domain/extensions/package-data.ts";
import {
  encodePackageData,
  type PackageDataDocument,
  type PackageDataReceipt,
  type PackageDataStore,
  packageDocumentDigest,
} from "../../domain/extensions/package-data-store.ts";
import { err, ok } from "../../domain/foundation/result.ts";

/** A host lifetime owns this memory. New hosts cannot resume its records or operation receipts. */
export function createEphemeralPackageState(source: PackageDataStore) {
  let document: PackageDataDocument | null = null;
  let closed = false;
  const receipts = new Map<string, PackageDataReceipt>();
  const store: PackageDataStore = {
    checkArtifacts: (document) =>
      source.checkArtifacts?.(document, false) ?? err({ code: "artifact-owner-unavailable" }),
    read(packageId) {
      if (closed) return err({ code: "ephemeral-owner-closed" });
      const current = source.read(packageId);
      if (!current.ok || current.value === null) return current;
      if (
        document === null ||
        document.packageDigest !== current.value.packageDigest ||
        document.configurationRevision !== current.value.configurationRevision
      ) {
        document = { ...structuredClone(current.value), records: [] };
        receipts.clear();
      }
      if (document.packageId !== packageId) return err({ code: "ephemeral-package-mismatch" });
      return ok(structuredClone(document));
    },
    receipt: (operationId) => ok(receipts.get(operationId) ?? null),
    recovery: () => err({ code: "ephemeral-recovery-unavailable" }),
    commit(input, signal) {
      if (closed || signal?.aborted || !input.authorize())
        return err({ code: "ephemeral-owner-closed" });
      if (
        document === null ||
        packageDocumentDigest(document) !== input.receipt.beforeDigest ||
        input.before.revision !== document.revision
      )
        return err({ code: "stale-data-revision" });
      if (
        input.after.records.some(
          (record) => !["process", "development"].includes(record.identity.scope),
        )
      )
        return err({ code: "ephemeral-scope-required" });
      if (receipts.size >= PACKAGE_DATA_LIMITS.retainedOperations)
        return err({ code: "ephemeral-operation-quota" });
      encodePackageData(input.after);
      document = structuredClone(input.after);
      receipts.set(input.receipt.operationId, structuredClone(input.receipt));
      return ok(input.receipt);
    },
  };
  return {
    store,
    close: () => {
      closed = true;
      document = null;
      receipts.clear();
    },
  };
}
