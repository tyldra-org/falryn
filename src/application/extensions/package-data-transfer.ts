import {
  bytesDigest,
  canonicalDigest,
  ExtensionInputError,
} from "../../domain/extensions/canonical.ts";
import { packageArtifactReferences } from "../../domain/extensions/package-artifacts.ts";
import {
  type ContributionConfigurationBinding,
  packageDataIdentity,
} from "../../domain/extensions/package-data.ts";
import type {
  PackageDataDocument,
  PackageDataReceipt,
} from "../../domain/extensions/package-data-store.ts";
import {
  type PackageDataAdoption,
  type PackageDataBundle,
  type PackageDataImportStore,
  packageDataBundleSchema,
} from "../../domain/extensions/package-data-transfer.ts";
import type { PackageDataAuthority, PackageDataResult } from "./package-data.ts";
import {
  dataFailure,
  migrateConfigurationValue,
  migrateState,
  safePackageValue,
  validatePackageSetting,
} from "./package-data-policy.ts";

/** Export contains data and omission facts. It never contains activation or adoption instructions. */
export function exportPackageData(
  document: PackageDataDocument,
  exportId: string,
  authority: PackageDataAuthority,
): PackageDataBundle {
  const bundle: PackageDataBundle = {
    version: 1,
    exportId,
    packageId: document.packageId,
    configuration: [],
    state: [],
    omissions: [],
  };
  for (const layer of document.layers) {
    if (!authority.allows(layer.scope, layer.owner, false)) continue;
    const values: typeof layer.values = {};
    const declarations = document.declarations.configuration.filter((declaration) =>
      Object.hasOwn(layer.values, declaration.id),
    );
    for (const declaration of declarations) {
      const value = layer.values[declaration.id];
      if (value === undefined) continue;
      if (declaration.sensitivity !== "public" || !validatePackageSetting(value, declaration)) {
        bundle.omissions.push({
          kind: "configuration",
          key: declaration.id,
          reason: "sensitivity-withheld",
        });
      } else values[declaration.id] = value;
    }
    const exported = { ...layer, values };
    const digest = canonicalDigest(values);
    const binding = authority.binding;
    bundle.configuration.push({
      id: canonicalDigest({ binding, layer: exported, digest }),
      binding,
      layer: exported,
      declarations: declarations.filter((declaration) => Object.hasOwn(values, declaration.id)),
      digest,
    });
  }
  for (const record of document.records) {
    if (!authority.allows(record.identity.scope, record.identity.owner, false)) continue;
    const declaration = document.declarations.state.find(
      (family) =>
        family.id === record.identity.family &&
        family.contribution === record.identity.contribution,
    );
    if (
      record.tombstone ||
      record.sensitivity !== "public" ||
      declaration?.export !== "inert" ||
      ["process", "development"].includes(record.identity.scope)
    ) {
      bundle.omissions.push({
        kind: "state",
        key: record.identity.key,
        reason: record.tombstone ? "tombstoned" : "policy-withheld",
      });
      continue;
    }
    bundle.state.push({ id: canonicalDigest(record), record: structuredClone(record) });
    if (packageArtifactReferences(record.value).length > 0)
      bundle.omissions.push({
        kind: "state",
        key: record.identity.key,
        reason: "artifact-bytes-require-native-artifact-transfer",
      });
  }
  return packageDataBundleSchema.parse(bundle);
}

export function validateInertPackageData(raw: unknown): PackageDataBundle {
  const text = JSON.stringify(raw);
  if (Buffer.byteLength(text) > 8_388_608) dataFailure("inert-data-byte-limit");
  const bundle = packageDataBundleSchema.parse(raw);
  const identities = new Set<string>();
  for (const entry of bundle.configuration) {
    if (
      identities.has(entry.id) ||
      entry.binding.packageId !== bundle.packageId ||
      entry.digest !== canonicalDigest(entry.layer.values) ||
      entry.id !==
        canonicalDigest({ binding: entry.binding, layer: entry.layer, digest: entry.digest })
    )
      dataFailure("invalid-inert-configuration");
    identities.add(entry.id);
    for (const declaration of entry.declarations) {
      if (
        declaration.sensitivity !== "public" ||
        !safePackageValue(declaration.default) ||
        !safePackageValue(declaration.schema) ||
        !safePackageValue(declaration.migrations)
      )
        dataFailure("inert-configuration-withheld");
    }
    if (
      new Set(entry.declarations.map((declaration) => declaration.id)).size !==
      entry.declarations.length
    )
      dataFailure("invalid-inert-configuration");
    for (const [key, value] of Object.entries(entry.layer.values)) {
      const declaration = entry.declarations.find((item) => item.id === key);
      if (declaration?.sensitivity !== "public" || !validatePackageSetting(value, declaration))
        dataFailure("inert-configuration-withheld");
    }
  }
  for (const entry of bundle.state) {
    const record = entry.record;
    if (
      identities.has(entry.id) ||
      record.identity.packageId !== bundle.packageId ||
      record.binding.packageId !== bundle.packageId ||
      record.digest !== canonicalDigest(record.value) ||
      record.bytes !== Buffer.byteLength(JSON.stringify(record.value)) ||
      entry.id !== canonicalDigest(record)
    )
      dataFailure("invalid-inert-state");
    identities.add(entry.id);
    if (
      record.sensitivity !== "public" ||
      record.tombstone ||
      !safePackageValue(record.value) ||
      ["process", "development"].includes(record.identity.scope)
    )
      dataFailure("inert-state-withheld");
  }
  return bundle;
}

export function importPackageData(
  options: {
    store: PackageDataImportStore;
    owner: string;
    packageId: string;
    operationId: string;
    raw: unknown;
    confirmation?: string;
  },
  signal?: AbortSignal,
): PackageDataResult {
  try {
    if (signal?.aborted) return { status: "failed", code: "cancelled" };
    const bundle = validateInertPackageData(options.raw);
    if (bundle.packageId !== options.packageId) dataFailure("inert-package-mismatch");
    const digest = bytesDigest(JSON.stringify(bundle));
    const confirmation = canonicalDigest({
      operationId: options.operationId,
      owner: options.owner,
      digest,
    });
    if (options.confirmation === undefined)
      return {
        status: "preview",
        confirmation,
        revision: 0,
        changes: [{ key: "inert-records", outcome: "created" }],
      };
    if (options.confirmation !== confirmation) dataFailure("stale-import-confirmation");
    const saved = options.store.save(options.operationId, options.owner, bundle, digest, signal);
    if (!saved.ok)
      return {
        status: saved.error.code === "uncertain" ? "uncertain" : "failed",
        code: saved.error.code,
      };
    return { status: "imported", receipt: saved.value };
  } catch (error) {
    return {
      status: "failed",
      code: error instanceof ExtensionInputError ? error.code : "invalid-inert-package-data",
    };
  }
}

/** Mutates only a staged document. The ordinary data transaction owns adoption and its recovery receipt. */
export function stagePackageDataAdoption(
  input: {
    document: PackageDataDocument;
    adoption: PackageDataAdoption;
    bundle: PackageDataBundle;
    authority: PackageDataAuthority;
    binding: ContributionConfigurationBinding;
    now: number;
  },
  signal?: AbortSignal,
): PackageDataReceipt["changes"] {
  const { document, adoption, authority, binding } = input;
  const bundle = validateInertPackageData(input.bundle);
  if (
    !authority.hostControl ||
    bundle.packageId !== document.packageId ||
    !authority.allows(adoption.scope, adoption.owner, true)
  )
    dataFailure("adoption-scope-denied");
  if (adoption.kind === "state") {
    const source = bundle.state.find((entry) => entry.id === adoption.source)?.record;
    if (!source) dataFailure("inert-source-unavailable");
    const declaration = document.declarations.state.find(
      (family) =>
        family.id === source.identity.family &&
        family.contribution === source.identity.contribution,
    );
    if (!declaration?.scopes.includes(adoption.scope)) dataFailure("adoption-family-unavailable");
    const identity = { ...source.identity, scope: adoption.scope, owner: adoption.owner };
    const previous = document.records.find(
      (record) => packageDataIdentity(record.identity) === packageDataIdentity(identity),
    );
    if ((previous?.revision ?? 0) !== adoption.expectedRevision)
      dataFailure("stale-adoption-revision");
    const migrated = migrateState(source, declaration, signal);
    if (previous?.tombstone) dataFailure("tombstoned-adoption-destination");
    if (previous?.digest === migrated.digest) return [{ key: identity.key, outcome: "unchanged" }];
    if (previous && adoption.collision === "retain")
      return [{ key: identity.key, outcome: "retained" }];
    const record = {
      ...migrated,
      identity,
      binding,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    document.records = document.records.filter(
      (item) => packageDataIdentity(item.identity) !== packageDataIdentity(identity),
    );
    document.records.push(record);
    return [{ key: identity.key, outcome: previous ? "replaced" : "created" }];
  }
  const source = bundle.configuration.find((entry) => entry.id === adoption.source);
  if (!source) dataFailure("inert-source-unavailable");
  let layer = document.layers.find(
    (item) => item.scope === adoption.scope && item.owner === adoption.owner,
  );
  if ((layer?.revision ?? 0) !== adoption.expectedRevision) dataFailure("stale-adoption-revision");
  const changes: PackageDataReceipt["changes"] = [];
  if (!layer) {
    layer = { scope: adoption.scope, owner: adoption.owner, revision: 0, values: {} };
    document.layers.push(layer);
  }
  for (const [key, rawValue] of Object.entries(source.layer.values)) {
    const from = source.declarations.find((declaration) => declaration.id === key);
    const to = document.declarations.configuration.find(
      (declaration) => declaration.id === key && declaration.contribution === from?.contribution,
    );
    if (!to || !from || !to.scopes.includes(adoption.scope))
      dataFailure("configuration-adoption-incompatible");
    const value = migrateConfigurationValue(rawValue, from, to, signal);
    if (!validatePackageSetting(value, to)) dataFailure("configuration-adoption-withheld");
    const current = layer.values[key];
    const outcome =
      current === undefined
        ? "created"
        : canonicalDigest(current) === canonicalDigest(value)
          ? "unchanged"
          : adoption.collision === "retain"
            ? "retained"
            : "replaced";
    if (outcome === "created" || outcome === "replaced") layer.values[key] = value;
    changes.push({ key, outcome });
  }
  if (changes.some((change) => change.outcome === "created" || change.outcome === "replaced")) {
    layer.revision++;
    document.configurationRevision++;
  }
  return changes;
}
