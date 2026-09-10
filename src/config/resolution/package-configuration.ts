import type {
  ConfigurationGenerationRecord,
  SensitiveValueRedactor,
} from "../../domain/configuration/index.ts";
import {
  CONFIGURATION_LAYER_ORDER,
  type ConfigurationScope,
  type ConfigurationValue,
  configurationKeyPath,
} from "../../domain/configuration/index.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import {
  type ContributionConfigurationBinding,
  matchesPackageSchema,
  type PackageConfigurationDeclaration,
  type PackageConfigurationSnapshot,
  packageDataValueSchema,
} from "../../domain/extensions/package-data.ts";
import { type ConfigurationKeyDeclaration, objectKey } from "../document/declaration.ts";
import { composeLayers, type LayerInput } from "./composition.ts";
import { diffGenerations } from "./generation.ts";
import { createConfigurationRegistry } from "./registry.ts";

export type PackageConfigurationLayer = {
  readonly scope: ConfigurationScope;
  readonly owner: string;
  readonly revision: number;
  readonly values: Readonly<Record<string, ConfigurationValue>>;
};
const sourceKinds = {
  user: "user-file",
  project: "project-file",
  profile: "profile",
  environment: "environment",
  cli: "cli-override",
} as const;
const applicationClasses = {
  live: "live",
  "next-operation": "next-operation",
  "next-turn": "next-turn",
  "contribution-restart": "reconnect",
  "host-restart": "application-restart",
} as const;

export function packageConfigurationPrefix(packageId: string): string {
  return `packages.p${canonicalDigest(packageId).slice(7, 39)}`;
}

/** Bind only this contribution's published values; the full host configuration never crosses the port. */
export function bindPackageConfiguration(
  record: ConfigurationGenerationRecord,
  binding: ContributionConfigurationBinding,
  declarations: readonly PackageConfigurationDeclaration[],
): PackageConfigurationSnapshot {
  if (record.generation !== binding.configurationGeneration)
    throw new ExtensionInputError("stale-configuration-generation");
  const prefix = packageConfigurationPrefix(binding.packageId);
  const values: PackageConfigurationSnapshot["values"] = {};
  const diagnostics: PackageConfigurationSnapshot["diagnostics"] = [];
  for (const declaration of declarations) {
    if (declaration.contribution !== null && declaration.contribution !== binding.contribution)
      continue;
    if (declaration.sensitivity === "credential-reference") {
      diagnostics.push({ code: "credential-resolution-owner-required", key: declaration.id });
      continue;
    }
    const value = record.values[`${prefix}.${declaration.id}`];
    if (!matchesPackageSchema(declaration.schema, value))
      throw new ExtensionInputError("invalid-package-configuration");
    values[declaration.id] = packageDataValueSchema.parse(value);
  }
  return { version: 1, binding, values, diagnostics, digest: canonicalDigest(values) };
}

export function packageConfigurationKeys(input: {
  readonly packageId: string;
  readonly declarations: readonly PackageConfigurationDeclaration[];
  readonly allowedScopes: readonly ConfigurationScope[];
  readonly validateSensitive: (
    value: unknown,
    declaration: PackageConfigurationDeclaration,
  ) => boolean;
}): ConfigurationKeyDeclaration[] {
  const prefix = packageConfigurationPrefix(input.packageId);
  const declarations: ConfigurationKeyDeclaration[] = input.declarations.map((declaration) => {
    const validate = (value: unknown) =>
      matchesPackageSchema(declaration.schema, value) &&
      input.validateSensitive(value, declaration);
    if (!validate(declaration.default)) throw new ExtensionInputError("invalid-package-default");
    const key = objectKey({
      path: `${prefix}.${declaration.id}`,
      summary: "Package-qualified setting",
      scopes: declaration.scopes.filter((scope) => input.allowedScopes.includes(scope)),
      applicationClass: applicationClasses[declaration.application],
      sensitivity: declaration.sensitivity,
      defaultValue: declaration.default,
      objectSchema: packageDataValueSchema.refine(validate),
    });
    return {
      ...key,
      descriptor: {
        ...key.descriptor,
        merge: declaration.merge,
        valueType:
          declaration.schema.type === "string" ||
          declaration.schema.type === "integer" ||
          declaration.schema.type === "boolean"
            ? declaration.schema.type
            : "object",
        environmentVariable:
          declaration.scopes.includes("environment") && declaration.sensitivity === "public"
            ? `FALRYN_PACKAGE_${canonicalDigest(input.packageId).slice(7, 39).toUpperCase()}_${declaration.id.replaceAll(".", "_").toUpperCase()}`
            : null,
        deprecation:
          declaration.deprecation === null
            ? null
            : {
                ...declaration.deprecation,
                deprecatedInSchemaVersion: declaration.schemaVersion,
                replacement:
                  declaration.deprecation.replacement === null
                    ? null
                    : configurationKeyPath(`${prefix}.${declaration.deprecation.replacement}`),
              },
      },
    };
  });
  const environmentNames = declarations.flatMap((declaration) =>
    declaration.descriptor.environmentVariable === null
      ? []
      : [declaration.descriptor.environmentVariable],
  );
  if (new Set(environmentNames).size !== environmentNames.length)
    throw new ExtensionInputError("duplicate-package-environment-bridge");
  return declarations;
}

/** The ordinary registry, merge and generation owners also own package configuration. */
export function composePackageConfiguration(input: {
  readonly packageId: string;
  readonly declarations: readonly PackageConfigurationDeclaration[];
  readonly layers: readonly PackageConfigurationLayer[];
  readonly allowedScopes: readonly ConfigurationScope[];
  readonly redactor: SensitiveValueRedactor;
  readonly validateSensitive: (
    value: unknown,
    declaration: PackageConfigurationDeclaration,
  ) => boolean;
  readonly previous?: Readonly<Record<string, ConfigurationValue>>;
}) {
  const prefix = packageConfigurationPrefix(input.packageId);
  const declarations = packageConfigurationKeys(input);
  const names = new Set(input.declarations.map((d) => d.id));
  if (names.size !== input.declarations.length)
    throw new ExtensionInputError("duplicate-package-key");
  const visited = new Set<string>();
  const visit = (id: string, active: Set<string>) => {
    if (active.has(id)) throw new ExtensionInputError("configuration-dependency-cycle");
    if (visited.has(id)) return;
    const declaration = input.declarations.find((d) => d.id === id);
    if (!declaration) throw new ExtensionInputError("unknown-configuration-dependency");
    active.add(id);
    for (const dependency of declaration.dependencies) visit(dependency, active);
    active.delete(id);
    visited.add(id);
  };
  for (const id of names) visit(id, new Set());
  const registry = createConfigurationRegistry({ declarations, redactor: input.redactor });
  const layers: LayerInput[] = input.layers.map((layer) => {
    const values: Record<string, ConfigurationValue> = {};
    for (const [id, value] of Object.entries(layer.values)) {
      if (!names.has(id)) throw new ExtensionInputError("unknown-package-key");
      const declaration = declarations.find((d) => d.descriptor.path === `${prefix}.${id}`);
      if (!declaration?.descriptor.scopes.includes(layer.scope))
        throw new ExtensionInputError("configuration-scope-denied");
      if (!declaration.validate(value).ok)
        throw new ExtensionInputError("invalid-package-configuration");
      values[`${prefix}.${id}`] = value;
    }
    return {
      source: {
        kind: sourceKinds[layer.scope],
        file: null,
        profile: layer.scope === "profile" ? layer.owner : null,
      },
      scope: layer.scope,
      values,
    };
  });
  // Ambiguous same-precedence sources are never resolved by input ordering.
  if (new Set(layers.map((layer) => layer.scope)).size !== layers.length)
    throw new ExtensionInputError("duplicate-configuration-layer");
  const composition = composeLayers({ registry, declarations, redactor: input.redactor, layers });
  if (composition.issues.length > 0)
    throw new ExtensionInputError("invalid-package-configuration-fold");
  const unqualify = (values: Readonly<Record<string, ConfigurationValue>>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key.slice(prefix.length + 1), value]),
    );
  const previous = Object.fromEntries(
    Object.entries(input.previous ?? {}).map(([id, value]) => [`${prefix}.${id}`, value]),
  );
  return {
    version: 1 as const,
    packageId: input.packageId,
    values: unqualify(composition.values),
    digest: canonicalDigest(composition.values),
    provenance: composition.provenance.map((p) => ({
      key: p.path.slice(prefix.length + 1),
      source: p.source.kind,
      value: p.redactedOriginal,
    })),
    overridden: composition.overridden.map((p) => ({
      key: p.path.slice(prefix.length + 1),
      source: p.source.kind,
      value: p.redactedOriginal,
    })),
    changes: diffGenerations(registry, previous, composition.values).map((change) => ({
      ...change,
      path: change.path.slice(prefix.length + 1),
    })),
    sourceOrder: CONFIGURATION_LAYER_ORDER,
  };
}
