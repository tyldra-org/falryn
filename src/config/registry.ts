/**
 * The configuration key registry.
 *
 * It answers what a key is, what it defaults to, whether a document is usable,
 * and how a value may be displayed. It opens no file, reads no environment, and
 * combines no layers: composition depends on this registry, never the reverse.
 *
 * Two behaviors are worth stating because they are easy to get backwards:
 *
 * - **An unknown key is an error, not a shrug.** A hand-edited file's typo that
 *   is silently ignored is a setting the author believes is in effect. The one
 *   exception is a document from a newer schema version, where an unknown key
 *   is additive data this build is allowed not to understand — it is dropped
 *   with a warning naming both versions.
 * - **Rendering withholds by declaration, not by inspection.** A value is
 *   shown because its key declares itself public, not because nothing in it
 *   looked like a secret.
 */

import {
  type ConfigurationIssue,
  type ConfigurationKeyDescriptor,
  type ConfigurationKeyPath,
  type ConfigurationKeyResolution,
  type ConfigurationLayerContext,
  type ConfigurationRegistryPort,
  type ConfigurationValidationResult,
  type ConfigurationValue,
  type ConfigurationValues,
  isBlockingIssue,
  MAX_CONFIGURATION_KEY_PATH_LENGTH,
  type SensitiveValueRedactor,
} from "../domain/index.ts";
import type { ConfigurationKeyDeclaration } from "./declaration.ts";
import {
  CONFIGURATION_MINIMUM_SCHEMA_VERSION,
  CONFIGURATION_SCHEMA_FAMILY,
  CONFIGURATION_SCHEMA_VERSION,
  evaluateSchemaVersion,
  RESERVED_DOCUMENT_FIELDS,
  type SchemaVersionPolicy,
  type SchemaVersionVerdict,
} from "./schema-family.ts";

/**
 * A rule over several keys at once.
 *
 * It runs after composition, so it sees an effective value rather than one
 * layer's opinion of it — which is the only point at which "these two settings
 * cannot both be true" is answerable.
 */
export type ConfigurationCrossFieldRule = {
  readonly id: string;
  /** Keys this rule reads. Reported with the conflict. */
  readonly paths: readonly ConfigurationKeyPath[];
  evaluate(values: ConfigurationValues): ConfigurationIssue | null;
};

export type ConfigurationRegistryOptions = {
  readonly declarations: readonly ConfigurationKeyDeclaration[];
  readonly crossFieldRules?: readonly ConfigurationCrossFieldRule[];
  /** The runtime's redactor, supplied by composition. */
  readonly redactor: SensitiveValueRedactor;
  readonly schemaFamily?: string;
  readonly schemaVersionPolicy?: SchemaVersionPolicy;
};

type Entry = {
  readonly declaration: ConfigurationKeyDeclaration;
  readonly aliasIndex: number | null;
};

/** How deep a document may nest before it stops being configuration. */
const MAX_DOCUMENT_DEPTH = 8;

export function createConfigurationRegistry(
  options: ConfigurationRegistryOptions,
): ConfigurationRegistryPort {
  const { redactor } = options;
  const rules = options.crossFieldRules ?? [];
  const policy = options.schemaVersionPolicy ?? {
    readerSchemaVersion: CONFIGURATION_SCHEMA_VERSION,
    minimumSupportedVersion: CONFIGURATION_MINIMUM_SCHEMA_VERSION,
  };

  const entries = new Map<string, Entry>();
  const prefixes = new Set<string>();

  const addPath = (path: string, entry: Entry): void => {
    if (entries.has(path)) {
      throw new Error(`duplicate configuration key path: ${path}`);
    }
    entries.set(path, entry);
    const segments = path.split(".");
    for (let index = 1; index < segments.length; index += 1) {
      prefixes.add(segments.slice(0, index).join("."));
    }
  };

  for (const declaration of options.declarations) {
    addPath(declaration.descriptor.path, { declaration, aliasIndex: null });
    declaration.descriptor.aliases.forEach((alias, aliasIndex) => {
      addPath(alias.path, { declaration, aliasIndex });
    });
  }

  const descriptors = options.declarations.map((declaration) => declaration.descriptor);

  const resolve = (path: string): ConfigurationKeyResolution => {
    const entry = entries.get(path);
    if (entry === undefined) {
      return { kind: "unknown" };
    }
    const alias =
      entry.aliasIndex === null
        ? null
        : (entry.declaration.descriptor.aliases[entry.aliasIndex] ?? null);
    return { kind: "known", descriptor: entry.declaration.descriptor, viaAlias: alias };
  };

  const defaults = (): ConfigurationValues => {
    const values: Record<string, ConfigurationValue> = {};
    for (const descriptor of descriptors) {
      values[descriptor.path] = descriptor.defaultValue;
    }
    return values;
  };

  const validateLayer = (
    document: unknown,
    context: ConfigurationLayerContext,
  ): ConfigurationValidationResult => {
    if (!isPlainObject(document)) {
      return {
        ok: false,
        issues: [{ kind: "invalid-type", severity: "error", path: "", expected: "object" }],
      };
    }

    const verdict = evaluateSchemaVersion(document, policy);
    if (verdict.kind === "rejected") {
      return { ok: false, issues: [verdict.issue] };
    }

    const issues: ConfigurationIssue[] = [];
    const values: Record<string, ConfigurationValue> = {};

    for (const found of collectAssignments(document, verdict, prefixes, resolve, policy)) {
      if (found.kind === "issue") {
        issues.push(found.issue);
        continue;
      }

      const { descriptor, alias } = found;
      if (alias !== null) {
        issues.push({
          kind: "alias-resolved",
          severity: "warning",
          path: alias.path,
          canonical: descriptor.path,
        });
      }
      if (descriptor.deprecation !== null) {
        issues.push({
          kind: "deprecated-key",
          severity: "warning",
          path: descriptor.path,
          replacement: descriptor.deprecation.replacement,
          removedInSchemaVersion: descriptor.deprecation.removedInSchemaVersion,
        });
      }
      if (!descriptor.scopes.includes(context.scope)) {
        issues.push({
          kind: "scope-unavailable",
          severity: "error",
          path: descriptor.path,
          scope: context.scope,
          availableScopes: descriptor.scopes,
        });
        continue;
      }

      const entry = entries.get(descriptor.path);
      const parsed = entry?.declaration.validate(found.raw);
      if (parsed === undefined || !parsed.ok) {
        issues.push(...(parsed?.error ?? []));
        continue;
      }
      values[descriptor.path] = parsed.value;
    }

    return issues.some(isBlockingIssue) ? { ok: false, issues } : { ok: true, values, issues };
  };

  const crossValidate = (values: ConfigurationValues): readonly ConfigurationIssue[] => {
    const issues: ConfigurationIssue[] = [];
    for (const rule of rules) {
      const issue = rule.evaluate(values);
      if (issue !== null) {
        issues.push(issue);
      }
    }
    return issues;
  };

  return {
    schemaFamily: options.schemaFamily ?? CONFIGURATION_SCHEMA_FAMILY,
    schemaVersion: policy.readerSchemaVersion,
    minimumSchemaVersion: policy.minimumSupportedVersion,

    keys: () => descriptors,

    describe: (path: string): ConfigurationKeyDescriptor | null =>
      entries.get(path)?.declaration.descriptor ?? null,

    resolve,
    defaults,
    validateLayer,
    crossValidate,

    /**
     * Defaults plus one document.
     *
     * This is the single-source path. Combining several layers applies each
     * key's declared merge behavior and belongs to the composition owner, which
     * calls `validateLayer` and `crossValidate` directly.
     */
    validateComplete(
      document: unknown,
      context: ConfigurationLayerContext,
    ): ConfigurationValidationResult {
      const layer = validateLayer(document, context);
      if (!layer.ok) {
        return layer;
      }
      const effective = { ...defaults(), ...layer.values };
      const conflicts = crossValidate(effective);
      const issues = [...layer.issues, ...conflicts];
      return issues.some(isBlockingIssue)
        ? { ok: false, issues }
        : { ok: true, values: effective, issues };
    },

    render(path: string, value: ConfigurationValue): ConfigurationValue {
      const descriptor = entries.get(path)?.declaration.descriptor;
      // An undeclared key has no declared sensitivity, so nothing authorizes
      // showing it.
      if (descriptor === undefined) {
        return redactor.placeholder;
      }
      switch (descriptor.sensitivity) {
        case "sensitive":
          return redactor.placeholder;
        case "credential-reference":
          return renderCredentialReference(value, redactor);
        case "public":
          return renderPublic(value, redactor);
      }
    },
  };
}

type Assignment = {
  readonly kind: "assignment";
  readonly descriptor: ConfigurationKeyDescriptor;
  readonly alias: { readonly path: ConfigurationKeyPath } | null;
  readonly raw: unknown;
};

type Found = Assignment | { readonly kind: "issue"; readonly issue: ConfigurationIssue };

/**
 * Walks a document and pairs each leaf with the key that owns it.
 *
 * Descent stops as soon as a path is a declared key, because everything below
 * it is that key's *value* — a map entry is not a nested key path, and treating
 * it as one is how a registry starts reporting a user's data as unknown keys.
 */
function collectAssignments(
  document: Readonly<Record<string, unknown>>,
  verdict: SchemaVersionVerdict,
  prefixes: ReadonlySet<string>,
  resolve: (path: string) => ConfigurationKeyResolution,
  policy: SchemaVersionPolicy,
): readonly Found[] {
  const found: Found[] = [];
  const tolerateUnknown = verdict.kind === "forward-compatible";

  const walk = (node: Readonly<Record<string, unknown>>, prefix: string, depth: number): void => {
    for (const [key, raw] of Object.entries(node)) {
      if (prefix === "" && RESERVED_DOCUMENT_FIELDS.includes(key)) {
        continue;
      }
      const path = prefix === "" ? key : `${prefix}.${key}`;
      const resolution = resolve(path);
      if (resolution.kind === "known") {
        found.push({
          kind: "assignment",
          descriptor: resolution.descriptor,
          alias: resolution.viaAlias,
          raw,
        });
        continue;
      }
      if (prefixes.has(path) && isPlainObject(raw) && depth < MAX_DOCUMENT_DEPTH) {
        walk(raw, path, depth + 1);
        continue;
      }
      found.push({
        kind: "issue",
        issue: tolerateUnknown
          ? {
              kind: "ignored-forward-key",
              severity: "warning",
              path: boundPath(path),
              observedSchemaVersion: verdict.schemaVersion,
              readerSchemaVersion: policy.readerSchemaVersion,
            }
          : { kind: "unknown-key", severity: "error", path: boundPath(path) },
      });
    }
  };

  walk(document, "", 0);
  return found;
}

function boundPath(path: string): string {
  return path.length > MAX_CONFIGURATION_KEY_PATH_LENGTH
    ? path.slice(0, MAX_CONFIGURATION_KEY_PATH_LENGTH)
    : path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A public value, still passed through the redactor.
 *
 * Declared-public means the key is not itself a secret; it does not mean a
 * string under it cannot contain one. A path override typed with a token in it
 * is exactly the case this catches.
 */
function renderPublic(
  value: ConfigurationValue,
  redactor: SensitiveValueRedactor,
): ConfigurationValue {
  if (typeof value === "string") {
    return redactor.redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((element) => renderPublic(element, redactor));
  }
  if (typeof value === "object" && value !== null) {
    const rendered: Record<string, ConfigurationValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      rendered[key] = redactor.isSecretName(key)
        ? redactor.placeholder
        : renderPublic(nested, redactor);
    }
    return rendered;
  }
  return value;
}

/**
 * A credential reference in outline.
 *
 * Store kind, consumer, and account label answer "is a credential configured,
 * and which one" without answering "what is it". The locator is withheld even
 * though it is not the secret: it is the string that reaches the store.
 */
function renderCredentialReference(
  value: ConfigurationValue,
  redactor: SensitiveValueRedactor,
): ConfigurationValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return redactor.placeholder;
  }
  const record = value as { readonly [key: string]: ConfigurationValue };
  return {
    storeKind: renderShortString(record.storeKind, redactor),
    consumer: renderShortString(record.consumer, redactor),
    accountLabel:
      record.accountLabel === null ? null : renderShortString(record.accountLabel, redactor),
    locator: redactor.placeholder,
    present: true,
  };
}

function renderShortString(
  value: ConfigurationValue | undefined,
  redactor: SensitiveValueRedactor,
): ConfigurationValue {
  return typeof value === "string" ? redactor.redactText(value, 120) : redactor.placeholder;
}
