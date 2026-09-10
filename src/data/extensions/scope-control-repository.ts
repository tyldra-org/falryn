import { z } from "zod";
import {
  canonicalDigest,
  ExtensionInputError,
  freezeMetadata,
} from "../../domain/extensions/canonical.ts";
import { CATALOG_LIMITS } from "../../domain/extensions/catalog.ts";
import { digestSchema } from "../../domain/extensions/identity.ts";
import {
  type ScopeControl,
  type ScopeControlStore,
  type ScopeReceipt,
  scopeAuthoritySelectionSchema,
  scopeControlDigest,
  scopeControlKey,
  scopeControlSchema,
  scopeReceiptSchema,
} from "../../domain/extensions/scope-controls.ts";
import { err, ok, type Result } from "../../domain/foundation/result.ts";
import type { Migration, SqliteRow, SqliteStorePort } from "../../domain/storage/index.ts";

export const SCOPE_CONTROL_TABLES = [
  "extension_scope_controls",
  "extension_scope_operations",
] as const;
export const MIGRATION_0019: Migration = {
  version: 19,
  name: "extension-scope-controls",
  destructive: false,
  statements: [
    "ALTER TABLE sessions ADD COLUMN extension_catalog TEXT",
    "CREATE TABLE extension_scope_controls (control_key TEXT PRIMARY KEY, actor TEXT NOT NULL, scope TEXT NOT NULL, authority_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL, metadata TEXT NOT NULL) STRICT",
    "CREATE INDEX extension_scope_controls_by_actor ON extension_scope_controls(actor, control_key)",
    "CREATE INDEX extension_scope_controls_by_authority ON extension_scope_controls(actor, scope, authority_id, control_key)",
    "CREATE TABLE extension_scope_operations (operation_id TEXT PRIMARY KEY, receipt TEXT NOT NULL) STRICT",
  ],
};

function fail(code: string): never {
  throw new ExtensionInputError(code);
}
function safely<T>(run: () => T): Result<T, { readonly code: string }> {
  try {
    return ok(run());
  } catch (error) {
    return err({ code: error instanceof ExtensionInputError ? error.code : "corrupt-scope-store" });
  }
}
function decodeControl(row: SqliteRow): ScopeControl {
  if (
    typeof row.metadata !== "string" ||
    Buffer.byteLength(row.metadata) > CATALOG_LIMITS.metadataBytes
  )
    return fail("scope-metadata-limit");
  try {
    const control = scopeControlSchema.parse(JSON.parse(row.metadata));
    if (
      control.revision !== row.revision ||
      control.actor !== row.actor ||
      control.authority.scope !== row.scope ||
      control.authority.id !== row.authority_id ||
      scopeControlKey(control) !== row.control_key ||
      scopeControlDigest(control) !== row.digest
    )
      return fail("corrupt-scope-store");
    return freezeMetadata(control);
  } catch (error) {
    if (error instanceof ExtensionInputError) throw error;
    return fail("corrupt-scope-store");
  }
}
function decodeReceipt(row: SqliteRow, operationId: string): ScopeReceipt {
  if (typeof row.receipt !== "string" || Buffer.byteLength(row.receipt) > 4_096)
    return fail("corrupt-scope-operation");
  try {
    const receipt = scopeReceiptSchema.parse(JSON.parse(row.receipt));
    if (receipt.operationId !== operationId || receipt.revision !== receipt.priorRevision + 1)
      return fail("corrupt-scope-operation");
    return freezeMetadata(receipt);
  } catch {
    return fail("corrupt-scope-operation");
  }
}

/** Uses the existing SQLite writer. It never owns package bytes or native registration. */
export function createScopeControlRepository(store: SqliteStorePort): ScopeControlStore {
  const read = (statement: string, parameters: Record<string, string | number>) => {
    const result = store.read(statement, parameters);
    if (!result.ok) return fail("scope-store-unavailable");
    return result.value;
  };
  return {
    get(key) {
      return safely(() => {
        if (!digestSchema.safeParse(key).success) return fail("invalid-scope-key");
        const row = read(
          "SELECT control_key, actor, scope, authority_id, revision, digest, CASE WHEN length(CAST(metadata AS BLOB)) <= $bytes THEN metadata END AS metadata FROM extension_scope_controls WHERE control_key=$key",
          { key, bytes: CATALOG_LIMITS.metadataBytes },
        )[0];
        return row === undefined ? null : decodeControl(row);
      });
    },
    list(actor, authorities) {
      return safely(() => {
        if (!digestSchema.safeParse(actor).success) return fail("invalid-scope-actor");
        if (
          authorities !== undefined &&
          (!Array.isArray(authorities) || authorities.length > CATALOG_LIMITS.controls)
        )
          return fail("invalid-scope-authorities");
        const selection =
          authorities === undefined
            ? undefined
            : scopeAuthoritySelectionSchema.safeParse(authorities);
        if (selection !== undefined && !selection.success) return fail("invalid-scope-authorities");
        // Only fixed SQL predicates are selected here; authority values remain bound data.
        const predicate =
          selection === undefined
            ? "actor=$actor"
            : "actor=$actor AND (scope,authority_id) IN (SELECT json_extract(value,'$.scope'),json_extract(value,'$.id') FROM json_each($authorities))";
        // Bound the selected authorities, not the actor's retained history.
        const rows = read(
          `WITH selected AS (SELECT * FROM extension_scope_controls WHERE ${predicate} ORDER BY control_key LIMIT $count)
           SELECT control_key,actor,scope,authority_id,revision,digest,
             sum(length(CAST(metadata AS BLOB))) OVER () AS total_bytes,
             CASE WHEN sum(length(CAST(metadata AS BLOB))) OVER () <= $bytes THEN metadata END AS metadata
           FROM selected ORDER BY control_key`,
          {
            actor,
            count: CATALOG_LIMITS.controls + 1,
            bytes: CATALOG_LIMITS.metadataBytes,
            ...(selection === undefined ? {} : { authorities: JSON.stringify(selection.data) }),
          },
        );
        if (rows.length > CATALOG_LIMITS.controls) return fail("scope-control-limit");
        if (
          rows.some(
            (row) =>
              typeof row.total_bytes !== "number" || row.total_bytes > CATALOG_LIMITS.metadataBytes,
          )
        )
          return fail("scope-metadata-limit");
        return freezeMetadata(rows.map(decodeControl));
      });
    },
    operation(id) {
      return safely(() => {
        if (!z.string().uuid().safeParse(id).success) return fail("invalid-scope-operation");
        const row = read(
          "SELECT substr(receipt,1,4097) AS receipt FROM extension_scope_operations WHERE operation_id=$id",
          { id },
        )[0];
        return row === undefined ? null : decodeReceipt(row, id);
      });
    },
    replace(controlInput, receiptInput, signal) {
      const checked = safely(() => {
        const control = scopeControlSchema.parse(controlInput);
        const receipt = scopeReceiptSchema.parse(receiptInput);
        const metadata = JSON.stringify(control);
        if (Buffer.byteLength(metadata) > CATALOG_LIMITS.metadataBytes)
          return fail("scope-metadata-limit");
        if (
          receipt.key !== scopeControlKey(control) ||
          receipt.controlDigest !== scopeControlDigest(control) ||
          receipt.revision !== control.revision ||
          receipt.revision !== receipt.priorRevision + 1
        )
          return fail("invalid-scope-publication");
        return { control, receipt, metadata };
      });
      if (!checked.ok) return checked;
      const { control, receipt, metadata } = checked.value;
      const written = store.write((sql): Result<ScopeReceipt, { readonly code: string }> => {
        if (signal.aborted) return err({ code: "cancelled" });
        const prior = sql.all(
          "SELECT substr(receipt,1,4097) AS receipt FROM extension_scope_operations WHERE operation_id=$id",
          { id: receipt.operationId },
        )[0];
        if (prior !== undefined) {
          const decoded = safely(() => decodeReceipt(prior, receipt.operationId));
          if (!decoded.ok) return decoded;
          return decoded.value.fingerprint === receipt.fingerprint &&
            decoded.value.confirmation === receipt.confirmation &&
            decoded.value.controlDigest === receipt.controlDigest
            ? decoded
            : err({ code: "scope-operation-conflict" });
        }
        const previous = sql.all(
          "SELECT control_key,actor,scope,authority_id,revision,digest,CASE WHEN length(CAST(metadata AS BLOB)) <= $bytes THEN metadata END AS metadata FROM extension_scope_controls WHERE control_key=$key",
          { key: receipt.key, bytes: CATALOG_LIMITS.metadataBytes },
        )[0];
        if (previous !== undefined) {
          const decoded = safely(() => decodeControl(previous));
          if (!decoded.ok) return decoded;
        }
        if ((previous?.revision ?? 0) !== receipt.priorRevision)
          return err({ code: "stale-scope-revision" });
        const installed = sql.all(
          "SELECT p.revision,v.identity_digest FROM installed_packages p JOIN package_versions v ON v.storage_id=p.storage_id WHERE p.package_id=$id AND v.state='retained'",
          { id: control.package.packageId },
        )[0];
        if (
          installed?.revision !== control.installedRevision ||
          installed?.identity_digest !== canonicalDigest(control.package)
        )
          return err({ code: "stale-package-revision" });
        if (control.authority.scope === "session") {
          const session = sql.all("SELECT session_id FROM sessions WHERE session_id=$id", {
            id: control.authority.id,
          })[0];
          if (session === undefined) return err({ code: "session-not-found" });
        }
        sql.run(
          "INSERT INTO extension_scope_controls(control_key,actor,scope,authority_id,revision,digest,metadata) VALUES($key,$actor,$scope,$authority,$revision,$digest,$metadata) ON CONFLICT(control_key) DO UPDATE SET actor=excluded.actor, scope=excluded.scope, authority_id=excluded.authority_id, revision=excluded.revision, digest=excluded.digest, metadata=excluded.metadata",
          {
            key: receipt.key,
            actor: control.actor,
            scope: control.authority.scope,
            authority: control.authority.id,
            revision: control.revision,
            digest: receipt.controlDigest,
            metadata,
          },
        );
        sql.run(
          "INSERT INTO extension_scope_operations(operation_id,receipt) VALUES($id,$receipt)",
          { id: receipt.operationId, receipt: JSON.stringify(receipt) },
        );
        return ok(freezeMetadata(receipt));
      }, signal);
      if (!written.ok)
        return err({
          code: written.error.effect === "uncertain" ? "uncertain" : "scope-write-failed",
        });
      return written.value.value;
    },
  };
}
