import type { z } from "zod";
import {
  bytesDigest,
  canonicalDigest,
  ExtensionInputError,
} from "../../domain/extensions/canonical.ts";
import {
  type ContributionConfigurationBinding,
  matchesPackageSchema,
  PACKAGE_DATA_LIMITS,
  type PackageStateRecord,
  packageDataIdentity,
  type packageStateOperationSchema,
} from "../../domain/extensions/package-data.ts";
import { packageDataRequestSchema } from "../../domain/extensions/package-data-control.ts";
import { validatePackageDataQuota } from "../../domain/extensions/package-data-limits.ts";
import {
  type PackageDataDocument,
  type PackageDataReceipt,
  type PackageDataStore,
  packageDocumentDigest,
} from "../../domain/extensions/package-data-store.ts";
import type {
  PackageDataImportReceipt,
  PackageDataImportStore,
} from "../../domain/extensions/package-data-transfer.ts";
import { copyPackageSessionState } from "../../domain/extensions/package-state-lifetime.ts";
import {
  dataFailure,
  foldPackageSettings,
  safePackageValue,
  validatePackageSettings,
} from "./package-data-policy.ts";
import { exportPackageData, stagePackageDataAdoption } from "./package-data-transfer.ts";

export type PackageDataResult =
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "uncertain"; readonly code: string }
  | { readonly status: "inspected"; readonly payload: unknown }
  | {
      readonly status: "preview";
      readonly confirmation: string;
      readonly changes: PackageDataReceipt["changes"];
      readonly revision: number;
      readonly adoption?: PackageDataReceipt["adoption"];
    }
  | { readonly status: "completed"; readonly receipt: PackageDataReceipt }
  | { readonly status: "imported"; readonly receipt: PackageDataImportReceipt };
export type PackageDataAuthority = {
  readonly binding: ContributionConfigurationBinding;
  /** Declaration/data revision admitted alongside the product configuration generation. */
  readonly configurationRevision?: number;
  readonly allows: (scope: string, owner: string, write: boolean) => boolean;
  readonly current: () => boolean;
  readonly hostControl: boolean;
  readonly principal?: string;
};

/** Narrow native service shared by human controls and future supervised contributions. */
export function createPackageDataService(options: {
  readonly store: PackageDataStore;
  /** Supplied by a host lifetime; it is never backed by SQLite or restored at startup. */
  readonly ephemeralStore?: PackageDataStore;
  readonly imports?: PackageDataImportStore;
  readonly authority: PackageDataAuthority;
  readonly now: () => number;
}) {
  const { authority } = options;
  const binding = authority.binding;
  return {
    run(raw: unknown, signal?: AbortSignal): PackageDataResult {
      try {
        const parsed = packageDataRequestSchema.safeParse(raw);
        if (!parsed.success) return { status: "failed", code: "invalid-package-data-request" };
        const request = parsed.data;
        const ephemeral =
          request.operation === "state" &&
          ["process", "development"].includes(request.state.identity.scope);
        const store = ephemeral ? options.ephemeralStore : options.store;
        if (!store) return { status: "failed", code: "ephemeral-state-owner-required" };
        if (signal?.aborted) return { status: "failed", code: "cancelled" };
        if (!authority.current()) return { status: "failed", code: "revoked-package-data" };
        if (request.operation === "import")
          return { status: "failed", code: "inert-import-owner-required" };
        const loaded = store.read(binding.packageId);
        if (!loaded.ok) return { status: "failed", code: loaded.error.code };
        if (!loaded.value) return { status: "failed", code: "package-data-unavailable" };
        const before = loaded.value;
        if (before.packageDigest !== binding.packageDigest)
          return { status: "failed", code: "stale-package-generation" };
        const after: PackageDataDocument = structuredClone(before);
        if (request.operation === "export") {
          if (!authority.hostControl) return { status: "failed", code: "export-denied" };
          return {
            status: "inspected",
            payload: exportPackageData(before, request.exportId, authority),
          };
        }
        const changes: PackageDataReceipt["changes"] = [];
        let adoption: PackageDataReceipt["adoption"];
        const intent = { ...request };
        delete intent.confirmation;
        // Retrying a committed request keeps its expected revision even after publication.
        const fingerprint = canonicalDigest({
          binding: { ...binding, configurationGeneration: request.expectedRevision },
          intent,
        });
        const existing = store.receipt(request.operationId);
        if (!existing.ok) return { status: "failed", code: existing.error.code };
        if (existing.value)
          return existing.value.fingerprint === fingerprint
            ? { status: "completed", receipt: existing.value }
            : { status: "failed", code: "operation-id-reused" };
        if (
          !authority.hostControl &&
          (authority.configurationRevision ?? binding.configurationGeneration) !==
            before.configurationRevision
        )
          return { status: "failed", code: "stale-configuration-generation" };
        if (request.operation === "inspect") {
          if (!authority.hostControl) return { status: "failed", code: "host-inspection-required" };
          const layers = before.layers.filter((l) => authority.allows(l.scope, l.owner, false));
          const settings = foldPackageSettings(before, layers);
          return {
            status: "inspected",
            payload: {
              version: 1,
              packageId: before.packageId,
              revision: before.revision,
              packageDigest: before.packageDigest,
              configuration: settings.provenance,
              overridden: settings.overridden,
              declarations: before.declarations.configuration.map(
                ({ id, scopes, sensitivity, application, schemaVersion, dependencies }) => ({
                  id,
                  scopes,
                  sensitivity,
                  application,
                  schemaVersion,
                  dependencies,
                }),
              ),
              state: before.declarations.state.map(
                ({
                  id,
                  scopes,
                  sensitivity,
                  retention,
                  cleanup,
                  schemaVersion,
                  maxBytes,
                  maxRecords,
                  fork,
                  export: exportPolicy,
                  migrations,
                }) => ({
                  id,
                  scopes,
                  sensitivity,
                  retention,
                  cleanup,
                  schemaVersion,
                  maxBytes,
                  maxRecords,
                  fork,
                  export: exportPolicy,
                  migrations: migrations.map(({ from, to }) => ({ from, to })),
                }),
              ),
              quota: {
                records: before.records.length,
                bytes: before.records.reduce((n, r) => n + r.bytes, 0),
              },
              activation: "unavailable",
            },
          };
        }
        if (
          request.operation === "state" &&
          ["get", "list-metadata"].includes(request.state.operation)
        ) {
          const state = request.state;
          const family = admitState(before, state.identity, false);
          const records = before.records.filter(
            (r) =>
              r.identity.family === family.id &&
              r.identity.contribution === state.identity.contribution &&
              r.identity.scope === state.identity.scope &&
              r.identity.owner === state.identity.owner,
          );
          if (state.operation === "get") {
            const record = records.find((r) => r.identity.key === state.identity.key);
            return {
              status: "inspected",
              payload: record
                ? {
                    revision: record.revision,
                    tombstone: record.tombstone,
                    digest: record.digest,
                    value: record.tombstone ? null : record.value,
                  }
                : { revision: 0, value: null },
            };
          }
          if (state.operation === "list-metadata")
            return {
              status: "inspected",
              payload: records
                .filter((r) => state.after === null || r.identity.key > state.after)
                .sort((a, b) => a.identity.key.localeCompare(b.identity.key))
                .slice(0, state.limit)
                .map(
                  ({
                    identity,
                    revision,
                    bytes,
                    digest,
                    tombstone,
                    schemaVersion,
                    sensitivity,
                  }) => ({
                    identity,
                    revision,
                    bytes,
                    digest,
                    tombstone,
                    schemaVersion,
                    sensitivity,
                  }),
                ),
            };
        }
        if (request.expectedRevision !== before.revision)
          return { status: "failed", code: "stale-data-revision" };
        switch (request.operation) {
          case "adopt": {
            if (!options.imports || authority.principal === undefined)
              dataFailure("inert-import-owner-required");
            const source = options.imports.read(request.adoption.importId, authority.principal);
            if (!source.ok || !source.value) dataFailure("inert-source-unavailable");
            const bundle = source.value.bundle;
            const selected = request.adoption;
            adoption = {
              importId: selected.importId,
              source: selected.source,
              sourceDigest: source.value.receipt.digest,
              kind: selected.kind,
              scope: selected.scope,
              owner: selected.owner,
              expectedRevision: selected.expectedRevision,
              omissions: bundle.omissions.length,
              migrations:
                selected.kind === "configuration"
                  ? (
                      bundle.configuration.find((entry) => entry.id === selected.source)
                        ?.declarations ?? []
                    ).map((from) => ({
                      key: from.id,
                      from: from.schemaVersion,
                      to:
                        after.declarations.configuration.find(
                          (to) => to.id === from.id && to.contribution === from.contribution,
                        )?.schemaVersion ?? from.schemaVersion,
                    }))
                  : bundle.state
                      .filter((entry) => entry.id === selected.source)
                      .map(({ record }) => ({
                        key: record.identity.key,
                        from: record.schemaVersion,
                        to:
                          after.declarations.state.find(
                            (family) =>
                              family.id === record.identity.family &&
                              family.contribution === record.identity.contribution,
                          )?.schemaVersion ?? record.schemaVersion,
                      })),
            };
            changes.push(
              ...stagePackageDataAdoption(
                {
                  document: after,
                  adoption: request.adoption,
                  bundle: source.value.bundle,
                  authority,
                  binding,
                  now: options.now(),
                },
                signal,
              ),
            );
            break;
          }
          case "configuration": {
            if (
              !authority.hostControl ||
              !authority.allows(request.layer.scope, request.layer.owner, true)
            )
              dataFailure("configuration-scope-denied");
            const index = after.layers.findIndex(
              (l) => l.scope === request.layer.scope && l.owner === request.layer.owner,
            );
            const previous = after.layers[index];
            if ((previous?.revision ?? 0) !== request.layer.revision)
              dataFailure("stale-configuration-revision");
            const layer = { ...request.layer, revision: request.layer.revision + 1 };
            if (canonicalDigest(previous?.values ?? {}) === canonicalDigest(layer.values)) {
              changes.push(
                ...Object.keys(layer.values).map((key) => ({ key, outcome: "unchanged" as const })),
              );
              break;
            }
            if (index < 0) after.layers.push(layer);
            else after.layers[index] = layer;
            after.configurationRevision++;
            for (const key of Object.keys(previous?.values ?? {}))
              if (!Object.hasOwn(layer.values, key)) changes.push({ key, outcome: "deleted" });
            for (const key of Object.keys(layer.values))
              changes.push({
                key,
                outcome: previous && Object.hasOwn(previous.values, key) ? "replaced" : "created",
              });
            break;
          }
          case "state": {
            const operation = request.state;
            if (
              operation.operation !== "put" &&
              operation.operation !== "compare-and-set" &&
              operation.operation !== "delete"
            )
              dataFailure("invalid-state-operation");
            const declaration = admitState(before, operation.identity, true);
            const index = after.records.findIndex(
              (r) => packageDataIdentity(r.identity) === packageDataIdentity(operation.identity),
            );
            const previous = after.records[index];
            if ((previous?.revision ?? 0) !== operation.expectedRevision)
              dataFailure("stale-state-revision");
            const tombstone = operation.operation === "delete";
            const value = tombstone ? null : operation.value;
            if (
              !tombstone &&
              (!matchesPackageSchema(declaration.schema, value) || !safePackageValue(value))
            )
              dataFailure("invalid-package-state");
            const bytes = Buffer.byteLength(JSON.stringify(value));
            if (bytes > declaration.maxBytes) dataFailure("state-value-quota-exceeded");
            const record: PackageStateRecord = {
              version: 1,
              identity: operation.identity,
              binding,
              schemaVersion: declaration.schemaVersion,
              revision: (previous?.revision ?? 0) + 1,
              value,
              digest: canonicalDigest(value),
              bytes,
              sensitivity: declaration.sensitivity,
              retention: declaration.retention,
              tombstone,
              createdAt: previous?.createdAt ?? options.now(),
              updatedAt: options.now(),
            };
            if (index < 0) after.records.push(record);
            else after.records[index] = record;
            changes.push({
              key: operation.identity.key,
              outcome: tombstone ? "deleted" : previous ? "replaced" : "created",
            });
            break;
          }
          case "reset": {
            if (!authority.hostControl || !authority.allows(request.scope, request.owner, true))
              dataFailure("reset-scope-denied");
            if (request.target === "configuration") {
              for (const layer of after.layers.filter(
                (l) => l.scope === request.scope && l.owner === request.owner,
              )) {
                const count = changes.length;
                for (const d of before.declarations.configuration.filter(
                  (d) =>
                    (request.contribution === null || d.contribution === request.contribution) &&
                    (request.key === null || d.id === request.key),
                )) {
                  if (Object.hasOwn(layer.values, d.id)) {
                    delete layer.values[d.id];
                    changes.push({ key: d.id, outcome: "deleted" });
                  }
                }
                if (changes.length > count) {
                  layer.revision++;
                  after.configurationRevision++;
                }
              }
            } else
              after.records = after.records.map((r) => {
                if (
                  r.tombstone ||
                  r.identity.scope !== request.scope ||
                  r.identity.owner !== request.owner ||
                  (request.contribution !== null &&
                    r.identity.contribution !== request.contribution) ||
                  (request.key !== null && r.identity.key !== request.key)
                )
                  return r;
                changes.push({ key: r.identity.key, outcome: "deleted" });
                return {
                  ...r,
                  revision: r.revision + 1,
                  tombstone: true,
                  value: null,
                  digest: canonicalDigest(null),
                  bytes: 4,
                  updatedAt: options.now(),
                };
              });
            break;
          }
          case "rollback": {
            if (!authority.hostControl) dataFailure("rollback-denied");
            const receipt = store.receipt(request.receiptId);
            const recovery = store.recovery(request.receiptId);
            if (!receipt.ok || !receipt.value || !recovery.ok || !recovery.value)
              dataFailure("recovery-unavailable");
            if (
              receipt.value.packageId !== binding.packageId ||
              receipt.value.afterRevision !== before.revision ||
              receipt.value.afterDigest !== packageDocumentDigest(before)
            )
              dataFailure("rollback-stale");
            if (recovery.value.packageDigest !== binding.packageDigest)
              dataFailure("rollback-package-incompatible");
            if (
              recovery.value.layers.some((l) => !authority.allows(l.scope, l.owner, true)) ||
              recovery.value.records.some(
                (r) => !authority.allows(r.identity.scope, r.identity.owner, true),
              )
            )
              dataFailure("rollback-scope-denied");
            after.layers = before.layers.map((layer) => ({
              ...layer,
              revision: layer.revision + 1,
              values:
                recovery.value?.layers.find(
                  (old) => old.scope === layer.scope && old.owner === layer.owner,
                )?.values ?? {},
            }));
            for (const layer of recovery.value.layers)
              if (
                !after.layers.some(
                  (current) => current.scope === layer.scope && current.owner === layer.owner,
                )
              )
                after.layers.push({ ...layer, revision: layer.revision + 1 });
            // Restoring values never reuses an old writer's revision or erases a tombstone.
            after.records = before.records.map((record) => {
              const old = recovery.value?.records.find(
                (item) =>
                  packageDataIdentity(item.identity) === packageDataIdentity(record.identity),
              );
              return {
                ...(old ?? record),
                revision: record.revision + 1,
                binding,
                updatedAt: options.now(),
                ...(old
                  ? {}
                  : { tombstone: true, value: null, digest: canonicalDigest(null), bytes: 4 }),
              };
            });
            for (const record of recovery.value.records)
              if (
                !after.records.some(
                  (current) =>
                    packageDataIdentity(current.identity) === packageDataIdentity(record.identity),
                )
              )
                after.records.push({
                  ...record,
                  revision: record.revision + 1,
                  binding,
                  updatedAt: options.now(),
                });
            after.configurationRevision++;
            changes.push({ key: "recovery", outcome: "replaced" });
            break;
          }
          case "fork": {
            if (
              !authority.hostControl ||
              request.from === request.to ||
              !authority.allows("session", request.from, false) ||
              !authority.allows("session", request.to, true)
            )
              dataFailure("fork-scope-denied");
            changes.push(
              ...copyPackageSessionState(
                after,
                request.from,
                request.to,
                () => ({ ...binding, sessionGeneration: request.generation }),
                options.now(),
              ).map((key) => ({ key, outcome: "created" as const })),
            );
            break;
          }
        }
        validatePackageDataQuota(after);
        const artifacts = store.checkArtifacts?.(after, authority.hostControl);
        if (artifacts && !artifacts.ok) dataFailure(artifacts.error.code);
        validatePackageSettings(after);
        const scopedLayers = after.layers.filter((l) => authority.allows(l.scope, l.owner, false));
        foldPackageSettings(after, scopedLayers);
        const changed = packageDocumentDigest(before) !== packageDocumentDigest(after);
        if (
          request.operation === "configuration" ||
          (request.operation === "reset" && request.target === "configuration") ||
          (request.operation === "adopt" && request.adoption.kind === "configuration")
        )
          for (const change of changes)
            change.application = before.declarations.configuration.find(
              (declaration) => declaration.id === change.key,
            )?.application;
        after.revision = before.revision + (changed ? 1 : 0);
        const receipt: PackageDataReceipt = {
          version: 1,
          operationId: request.operationId,
          packageId: binding.packageId,
          fingerprint,
          beforeRevision: before.revision,
          afterRevision: after.revision,
          beforeDigest: packageDocumentDigest(before),
          afterDigest: packageDocumentDigest(after),
          status: changed ? "completed" : "unchanged",
          changes,
          binding,
          ...(adoption === undefined ? {} : { adoption }),
        };
        if (Buffer.byteLength(JSON.stringify(receipt)) > PACKAGE_DATA_LIMITS.receiptBytes)
          dataFailure("package-receipt-quota-exceeded");
        const confirmation = canonicalDigest({
          fingerprint,
          before: receipt.beforeDigest,
          after: bytesDigest(
            JSON.stringify({
              ...after,
              records: after.records.map(
                ({ createdAt: _createdAt, updatedAt: _updatedAt, ...record }) => record,
              ),
            }),
          ),
        });
        if (request.confirmation === undefined)
          return {
            status: "preview",
            confirmation,
            changes,
            revision: before.revision,
            ...(adoption === undefined ? {} : { adoption }),
          };
        if (request.confirmation !== confirmation)
          return { status: "failed", code: "stale-data-confirmation" };
        const committed = store.commit(
          {
            binding,
            before,
            after,
            receipt,
            authorize: authority.current,
            allowArtifactClaim: authority.hostControl,
          },
          signal,
        );
        if (!committed.ok)
          return {
            status: committed.error.code === "uncertain" ? "uncertain" : "failed",
            code: committed.error.code,
          };
        return { status: "completed", receipt: committed.value };
      } catch (error) {
        return {
          status: "failed",
          code: error instanceof ExtensionInputError ? error.code : "package-data-failed",
        };
      }
    },
  };
  function admitState(
    document: PackageDataDocument,
    identity: z.infer<typeof packageStateOperationSchema>["identity"],
    write: boolean,
  ) {
    if (
      identity.packageId !== binding.packageId ||
      (!authority.hostControl && identity.contribution !== binding.contribution) ||
      !authority.allows(identity.scope, identity.owner, write)
    )
      dataFailure("state-scope-denied");
    if (["process", "development"].includes(identity.scope) && options.ephemeralStore === undefined)
      dataFailure("ephemeral-state-owner-required");
    const declaration = document.declarations.state.find(
      (d) => d.id === identity.family && d.contribution === identity.contribution,
    );
    if (!declaration?.scopes.includes(identity.scope)) dataFailure("state-declaration-unavailable");
    return declaration;
  }
}
