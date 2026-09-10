import { satisfies } from "semver";
import {
  composePackageConfiguration,
  type PackageConfigurationLayer,
} from "../../config/resolution/package-configuration.ts";
import type { JsonValue } from "../../domain/extensions/canonical.ts";
import {
  canonicalDigest,
  canonicalJson,
  ExtensionInputError,
} from "../../domain/extensions/canonical.ts";
import {
  matchesPackageSchema,
  PACKAGE_DATA_LIMITS,
  type PackageConfigurationDeclaration,
  type PackageStateDeclaration,
  type PackageStateRecord,
} from "../../domain/extensions/package-data.ts";
import { validatePackageDataQuota } from "../../domain/extensions/package-data-limits.ts";
import {
  type PackageDataDeclarations,
  type PackageDataDocument,
  packageDataDeclarationsSchema,
} from "../../domain/extensions/package-data-store.ts";
import {
  containsRedactableSecret,
  createRuntimeRedactor,
  isSecretName,
} from "../diagnostics/redaction.ts";
import type { PreparedPackage } from "./prepare-package.ts";

export function dataFailure(code: string): never {
  throw new ExtensionInputError(code);
}

/** Detection is a rejection aid, never a claim that arbitrary text cannot contain secrets. */
export function safePackageValue(value: unknown): boolean {
  const text = canonicalJson(value);
  if (containsRedactableSecret(text)) return false;
  const inspect = (item: unknown): boolean => {
    if (Array.isArray(item)) return item.every(inspect);
    if (item !== null && typeof item === "object")
      return Object.entries(item).every(
        ([key, v]) =>
          !isSecretName(key) &&
          !["prompt", "messages", "environment", "sql", "sourceCode", "executable"].includes(key) &&
          inspect(v),
      );
    return true;
  };
  return inspect(value);
}
export function validatePackageSetting(
  value: unknown,
  declaration: PackageConfigurationDeclaration,
): boolean {
  if (declaration.sensitivity !== "credential-reference") return safePackageValue(value);
  // Resolution is owned by the credential service; an ordinary data operation cannot resolve it.
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return (
    Object.keys(reference).every((key) =>
      ["storeKind", "locator", "consumer", "accountLabel"].includes(key),
    ) &&
    ["operating-system-keychain", "provider-login", "environment", "local-file"].includes(
      String(reference.storeKind),
    ) &&
    typeof reference.locator === "string" &&
    reference.locator.length > 0 &&
    reference.locator.length <= 1024 &&
    typeof reference.consumer === "string" &&
    reference.consumer === declaration.contribution &&
    (reference.accountLabel === null || typeof reference.accountLabel === "string") &&
    !containsRedactableSecret(reference.locator)
  );
}
export function packageDeclarations(prepared: PreparedPackage): PackageDataDeclarations {
  const declarations = packageDataDeclarationsSchema.safeParse({
    configuration: prepared.falryn.configuration,
    state: prepared.falryn.state,
  });
  if (!declarations.success) return dataFailure("package-data-schema-upgrade-required");
  const result = declarations.data;
  for (const list of [result.configuration, result.state]) {
    if (new Set(list.map((d) => d.id)).size !== list.length)
      dataFailure("duplicate-package-data-declaration");
    for (const d of list) {
      if (Buffer.byteLength(canonicalJson(d.schema)) > 16_384) dataFailure("schema-byte-limit");
      if (!safePackageValue(d.schema)) dataFailure("unsafe-package-schema");
      if (
        d.contribution !== null &&
        !prepared.contributions.some(
          (c) =>
            c.identityDigest === d.contribution ||
            `${c.identity.namespace}/${c.identity.localId}` === d.contribution,
        )
      )
        dataFailure("foreign-contribution-declaration");
    }
  }
  for (const d of result.configuration) {
    if (
      prepared.identity.packageVersion === null ||
      !satisfies(prepared.identity.packageVersion, d.compatibility)
    )
      dataFailure("configuration-version-incompatible");
    if (d.sensitivity === "credential-reference" && d.default !== null)
      dataFailure("credential-default-forbidden");
  }
  for (const declaration of [...result.state, ...result.configuration])
    validateMigrationGraph(declaration);
  return result;
}

function validateMigrationGraph(
  declaration: Pick<PackageStateDeclaration, "schemaVersion" | "migrations">,
): void {
  const graph = new Map<number, number>();
  for (const migration of declaration.migrations) {
    if (graph.has(migration.from)) dataFailure("ambiguous-state-migration");
    graph.set(migration.from, migration.to);
    for (const step of migration.steps)
      if (step.kind === "default" && !safePackageValue(step.value))
        dataFailure("invalid-migration-default");
  }
  for (const source of graph.keys()) {
    const seen = new Set<number>();
    let current = source;
    while (current !== declaration.schemaVersion) {
      if (seen.has(current)) dataFailure("migration-cycle");
      seen.add(current);
      const next = graph.get(current);
      if (next === undefined) dataFailure("incomplete-state-migration");
      current = next;
    }
  }
}
export function foldPackageSettings(
  document: PackageDataDocument,
  layers: readonly PackageConfigurationLayer[] = document.layers,
) {
  return composePackageConfiguration({
    packageId: document.packageId,
    declarations: document.declarations.configuration,
    layers,
    allowedScopes: ["user", "project", "profile", "environment", "cli"],
    redactor: createRuntimeRedactor(),
    validateSensitive: validatePackageSetting,
  });
}

function migrateDeclaredValue(
  raw: unknown,
  sourceVersion: number,
  declaration: Pick<PackageStateDeclaration, "schemaVersion" | "migrations">,
  signal?: AbortSignal,
): JsonValue {
  let schemaVersion = sourceVersion;
  const value: JsonValue = JSON.parse(canonicalJson(raw));
  const visited = new Set<number>();
  while (schemaVersion !== declaration.schemaVersion) {
    if (signal?.aborted) dataFailure("cancelled");
    if (visited.has(schemaVersion) || visited.size >= PACKAGE_DATA_LIMITS.migrations)
      dataFailure("migration-cycle");
    visited.add(schemaVersion);
    const edges = declaration.migrations.filter((m) => m.from === schemaVersion);
    if (edges.length !== 1) dataFailure("state-migration-unavailable");
    const migration = edges[0];
    if (!migration) dataFailure("state-migration-unavailable");
    if (value === null || typeof value !== "object" || Array.isArray(value))
      dataFailure("migration-object-required");
    for (const step of migration.steps) {
      if (step.kind === "rename") {
        if (!Object.hasOwn(value, step.from) || Object.hasOwn(value, step.to))
          dataFailure("migration-collision");
        const previous = value[step.from];
        if (previous === undefined) dataFailure("migration-source-missing");
        value[step.to] = previous;
        delete value[step.from];
      } else if (step.kind === "default") {
        if (!Object.hasOwn(value, step.key)) value[step.key] = step.value;
      } else delete value[step.key];
    }
    schemaVersion = migration.to;
  }
  return value;
}

export function migrateConfigurationValue(
  value: unknown,
  from: PackageConfigurationDeclaration,
  to: PackageConfigurationDeclaration,
  signal?: AbortSignal,
): JsonValue {
  if (from.contribution !== to.contribution || from.id !== to.id)
    dataFailure("foreign-configuration-migration");
  if (from.sensitivity !== "public" && to.sensitivity === "public")
    dataFailure("configuration-sensitivity-downgrade");
  const migrated = migrateDeclaredValue(value, from.schemaVersion, to, signal);
  if (!matchesPackageSchema(to.schema, migrated) || !validatePackageSetting(migrated, to))
    dataFailure("invalid-migrated-configuration");
  return migrated;
}

export function migrateState(
  record: PackageStateRecord,
  declaration: PackageStateDeclaration,
  signal?: AbortSignal,
): PackageStateRecord {
  if (signal?.aborted) dataFailure("cancelled");
  if (record.tombstone) return { ...record, schemaVersion: declaration.schemaVersion };
  const value = migrateDeclaredValue(record.value, record.schemaVersion, declaration, signal);
  const schemaVersion = declaration.schemaVersion;
  if (
    !record.tombstone &&
    (!matchesPackageSchema(declaration.schema, value) || !safePackageValue(value))
  )
    dataFailure("invalid-migrated-state");
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > declaration.maxBytes) dataFailure("state-value-quota-exceeded");
  const sensitivity = ["public", "sensitive", "restricted"] as const;
  if (sensitivity.indexOf(declaration.sensitivity) < sensitivity.indexOf(record.sensitivity))
    dataFailure("state-sensitivity-downgrade");
  return {
    ...record,
    schemaVersion,
    value,
    digest: canonicalDigest(value),
    bytes,
    sensitivity: declaration.sensitivity,
    retention: declaration.retention,
  };
}

/** Validate every stored context without merging unrelated workspace or profile owners. */
export function validatePackageSettings(document: PackageDataDocument): void {
  const groups = new Map<string, PackageConfigurationLayer[]>();
  const identities = new Set<string>();
  for (const layer of document.layers) {
    const identity = `${layer.scope}:${layer.owner}`;
    if (identities.has(identity)) dataFailure("duplicate-configuration-layer");
    identities.add(identity);
    const group = groups.get(layer.scope) ?? [];
    group.push(layer);
    groups.set(layer.scope, group);
  }
  let contexts: PackageConfigurationLayer[][] = [[]];
  for (const group of groups.values()) {
    if (contexts.length * group.length > 1_024) dataFailure("configuration-context-limit");
    contexts = contexts.flatMap((context) => group.map((layer) => [...context, layer]));
  }
  foldPackageSettings(document, []);
  for (const context of contexts) foldPackageSettings(document, context);
}

/** Staging has no effects. Lifecycle publication commits this result with the package bytes. */
export function preparePackageDataPublication(
  before: PackageDataDocument | null,
  prepared: PreparedPackage,
  signal?: AbortSignal,
  packageRevision?: number,
): PackageDataDocument {
  const declarations = packageDeclarations(prepared);
  const document: PackageDataDocument = {
    version: 1,
    packageId: prepared.identity.packageId,
    packageDigest: prepared.identityDigest,
    revision: (before?.revision ?? 0) + 1,
    declarations,
    configurationRevision: (before?.configurationRevision ?? 0) + 1,
    layers: (before?.layers ?? []).map((layer) => ({
      ...layer,
      values: Object.fromEntries(
        Object.entries(layer.values).map(([key, value]) => {
          const from = before?.declarations.configuration.find(
            (declaration) => declaration.id === key,
          );
          const to = declarations.configuration.find((declaration) => declaration.id === key);
          if (!from || !to) dataFailure("configuration-key-still-owned");
          return [key, migrateConfigurationValue(value, from, to, signal)];
        }),
      ),
    })),
    records: [],
  };
  document.records = (before?.records ?? []).map((record) => {
    if (signal?.aborted) dataFailure("cancelled");
    const declaration = declarations.state.find(
      (d) => d.id === record.identity.family && d.contribution === record.identity.contribution,
    );
    if (!declaration) {
      if (!record.tombstone) dataFailure("state-family-still-owned");
      return record;
    }
    const migrated = migrateState(record, declaration, signal);
    return {
      ...migrated,
      revision:
        record.revision +
        (migrated.digest !== record.digest || migrated.schemaVersion !== record.schemaVersion
          ? 1
          : 0),
      binding: {
        ...record.binding,
        packageDigest: prepared.identityDigest,
        packageVersion: prepared.identity.packageVersion ?? record.binding.packageVersion,
        packageRevision: packageRevision ?? record.binding.packageRevision + 1,
        configurationGeneration: document.configurationRevision,
        catalogGeneration: prepared.identityDigest,
      },
    };
  });
  validatePackageDataQuota(document);
  validatePackageSettings(document);
  return document;
}
