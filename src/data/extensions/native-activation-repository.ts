import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type NativeActivationStore,
  nativeActivationKey,
  nativeActivationReceiptSchema,
  nativeActivationSchema,
} from "../../domain/extensions/native-activation.ts";
import { scopeControlSchema } from "../../domain/extensions/scope-controls.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";

export const NATIVE_ACTIVATION_TABLES = [
  "extension_native_activations",
  "extension_native_operations",
] as const;
export const MIGRATION_0024: Migration = {
  version: 24,
  name: "extension-native-activations",
  destructive: false,
  statements: [
    "CREATE TABLE extension_native_activations (activation_key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0), record_json TEXT NOT NULL CHECK(length(CAST(record_json AS BLOB)) BETWEEN 1 AND 131072)) STRICT",
    "CREATE TABLE extension_native_operations (operation_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL CHECK(length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 131072)) STRICT",
  ],
};

function decode(raw: unknown, maximum = 131_072) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > maximum)
    throw new Error("invalid-activation-record");
  return JSON.parse(raw) as unknown;
}

export function createNativeActivationRepository(store: SqliteStorePort): NativeActivationStore {
  return {
    get(key) {
      try {
        const rows = store.read(
          "SELECT * FROM extension_native_activations WHERE activation_key=$key",
          { key },
        );
        if (!rows.ok) return err({ code: "activation-store-unavailable" });
        const row = rows.value[0];
        if (!row) return ok(null);
        const record = nativeActivationSchema.parse(decode(row.record_json));
        if (nativeActivationKey(record) !== key || record.revision !== row.revision)
          throw new Error("invalid-activation-record");
        return ok(record);
      } catch {
        return err({ code: "activation-record-malformed" });
      }
    },
    operation(id) {
      try {
        const rows = store.read(
          "SELECT receipt_json FROM extension_native_operations WHERE operation_id=$id",
          { id },
        );
        if (!rows.ok) return err({ code: "activation-store-unavailable" });
        const row = rows.value[0];
        if (!row) return ok(null);
        const receipt = nativeActivationReceiptSchema.parse(decode(row.receipt_json));
        if (
          receipt.operation !== id ||
          receipt.key !== nativeActivationKey(receipt.record) ||
          receipt.record.revision !== receipt.priorRevision + 1
        )
          throw new Error("invalid-activation-receipt");
        return ok(receipt);
      } catch {
        return err({ code: "activation-record-malformed" });
      }
    },
    save(raw, scopeRevision, signal) {
      try {
        const receipt = nativeActivationReceiptSchema.parse(raw);
        if (
          receipt.key !== nativeActivationKey(receipt.record) ||
          receipt.record.revision !== receipt.priorRevision + 1
        )
          return err({ code: "invalid-activation-revision" });
        const saved = store.write((tx) => {
          if (signal.aborted) return "cancelled";
          const existing = tx.all(
            "SELECT receipt_json FROM extension_native_operations WHERE operation_id=$id",
            { id: receipt.operation },
          )[0];
          if (existing)
            return canonicalDigest(decode(existing.receipt_json)) === canonicalDigest(receipt)
              ? null
              : "activation-operation-reused";
          const prior = tx.all(
            "SELECT revision FROM extension_native_activations WHERE activation_key=$key",
            { key: receipt.key },
          )[0];
          if ((prior?.revision ?? 0) !== receipt.priorRevision) return "stale-activation-revision";
          const scope = tx.all(
            "SELECT revision, metadata FROM extension_scope_controls WHERE control_key=$key",
            { key: receipt.record.scopeKey },
          )[0];
          if (scope?.revision !== scopeRevision) return "stale-activation-scope";
          // Scope metadata is validated by its owner before this transaction. Recheck its
          // exact installed revision in the same writer that commits the activation.
          const scopeValue = scopeControlSchema.parse(decode(scope.metadata, 16_777_216));
          if (canonicalDigest(scopeValue.package) !== receipt.record.package)
            return "stale-activation-package";
          if (
            scopeValue.actor !== receipt.record.actor ||
            scopeValue.scopeBinding !== receipt.record.scopeBinding ||
            canonicalDigest(scopeValue.authority) !== canonicalDigest(receipt.record.authority)
          )
            return "stale-activation-scope";
          if (
            !receipt.record.contributions.every((id) =>
              scopeValue.contributions.some((entry) => canonicalDigest(entry.identity) === id),
            )
          )
            return "activation-contribution-missing";
          const installed = tx.all(
            "SELECT p.revision, v.identity_digest, v.state FROM installed_packages p JOIN package_versions v ON p.storage_id=v.storage_id WHERE p.package_id=$id",
            { id: scopeValue.package.packageId },
          )[0];
          if (
            installed?.revision !== receipt.record.installedRevision ||
            installed.identity_digest !== receipt.record.package ||
            installed.state !== "retained"
          )
            return "stale-activation-package";
          tx.run(
            "INSERT INTO extension_native_activations(activation_key,revision,record_json) VALUES($key,$revision,$json) ON CONFLICT(activation_key) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json",
            {
              key: receipt.key,
              revision: receipt.record.revision,
              json: JSON.stringify(receipt.record),
            },
          );
          tx.run(
            "INSERT INTO extension_native_operations(operation_id,receipt_json) VALUES($id,$json)",
            { id: receipt.operation, json: JSON.stringify(receipt) },
          );
          return null;
        });
        if (!saved.ok)
          return err({
            code:
              saved.error.effect === "uncertain"
                ? "activation-store-uncertain"
                : "activation-store-unavailable",
          });
        return saved.value.value === null ? ok(receipt) : err({ code: saved.value.value });
      } catch {
        return err({ code: "activation-store-conflict" });
      }
    },
  };
}
