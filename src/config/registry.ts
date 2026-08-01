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
  type ConfigurationMergeBehavior,
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
     * This is the single-source path. Combining several *layers* applies the
     * same declared behavior across sources and belongs to the composition
     * owner, which calls `validateLayer` and `crossValidate` directly.
     *
     * Folding the document over the defaults is itself a merge, so it obeys
     * each key's declaration rather than replacing wholesale. Replacing would
     * make a document that sets one entry of a `merge-map` key drop every
     * default entry beside it — and a cross-field rule reading that value would
     * then approve a configuration the complete value violates.
     */
    validateComplete(
      document: unknown,
      context: ConfigurationLayerContext,
    ): ConfigurationValidationResult {
      const layer = validateLayer(document, context);
      if (!layer.ok) {
        return layer;
      }
      const effective = foldOverDefaults(descriptors, defaults(), layer.values);
      const folded = revalidateFolded(entries, layer.values, effective);
      const conflicts = crossValidate(effective);
      const issues = [...layer.issues, ...folded, ...conflicts];
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

/**
 * Checks each folded value against the declaration that bounds it.
 *
 * Per-key validation runs on what a document *said*, and a fold can produce a
 * value neither side stated: a `merge-by-identity` list at exactly its maximum,
 * folded onto a non-empty default, is longer than either input and longer than
 * the key allows. A declared bound the effective value does not obey is the
 * same defect as a silent clamp.
 *
 * Every folded key is rechecked, not only the ones whose merge grows a value.
 * Rechecking a `replace` is provably redundant today, and paying that to have
 * the guarantee hold for whatever merge behavior is declared next is the right
 * trade — the alternative is a rule that silently stops covering a new shape.
 */
function revalidateFolded(
  entries: ReadonlyMap<string, Entry>,
  layerValues: ConfigurationValues,
  effective: ConfigurationValues,
): readonly ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  for (const path of Object.keys(layerValues)) {
    const declaration = entries.get(path)?.declaration;
    const value = effective[path];
    if (declaration === undefined || value === undefined) {
      continue;
    }
    const rechecked = declaration.validate(value);
    if (!rechecked.ok) {
      issues.push(...rechecked.error);
    }
  }
  return issues;
}

/**
 * Folds one document's values onto the defaults, per key declaration.
 *
 * The composition owner performs the same fold repeatedly across its six
 * layers. It lives here for now because the defaults fold is the one merge this
 * area cannot avoid performing: without it, `crossValidate` would see a value
 * that is complete only by accident.
 */
function foldOverDefaults(
  descriptors: readonly ConfigurationKeyDescriptor[],
  defaults: ConfigurationValues,
  layer: ConfigurationValues,
): ConfigurationValues {
  const effective: Record<string, ConfigurationValue> = { ...defaults };
  for (const descriptor of descriptors) {
    const incoming = layer[descriptor.path];
    if (incoming === undefined) {
      continue;
    }
    effective[descriptor.path] = foldDeclaredValue(
      descriptor.merge,
      defaults[descriptor.path],
      incoming,
    );
  }
  return effective;
}

/**
 * One key's declared merge, exported for the composition owner.
 *
 * Composition folds the same declarations across six layers that this module
 * folds across two, and a second implementation of the same rule is a second
 * chance to get it wrong.
 *
 * A shape mismatch falls back to replacement rather than guessing: a base that
 * is not the shape the declaration describes cannot be merged into, and
 * inventing a combination there would be exactly the accidental deep merge this
 * contract exists to prevent.
 */
export function foldDeclaredValue(
  merge: ConfigurationMergeBehavior,
  base: ConfigurationValue | undefined,
  incoming: ConfigurationValue,
): ConfigurationValue {
  switch (merge.kind) {
    case "replace":
      return incoming;
    case "merge-map":
      // One level only. An entry is a value, not a nested key path.
      return isValueRecord(base) && isValueRecord(incoming) ? { ...base, ...incoming } : incoming;
    case "merge-by-identity":
      return Array.isArray(base) && Array.isArray(incoming)
        ? foldByIdentity(base, incoming, merge.identityField)
        : incoming;
  }
}

/**
 * Elements sharing the declared identity are the same element.
 *
 * A matched element is amended in place, so the base's order is preserved and a
 * later layer can change one entry without restating the list. An unmatched
 * element is appended.
 */
function foldByIdentity(
  base: readonly ConfigurationValue[],
  incoming: readonly ConfigurationValue[],
  identityField: string,
): readonly ConfigurationValue[] {
  const result = [...base];
  const positionByIdentity = new Map<string, number>();
  base.forEach((element, index) => {
    const identity = identityOf(element, identityField);
    if (identity !== null) {
      positionByIdentity.set(identity, index);
    }
  });

  for (const element of incoming) {
    const identity = identityOf(element, identityField);
    const position = identity === null ? undefined : positionByIdentity.get(identity);
    if (position === undefined) {
      if (identity !== null) {
        positionByIdentity.set(identity, result.length);
      }
      result.push(element);
      continue;
    }
    result[position] = element;
  }
  return result;
}

function identityOf(element: ConfigurationValue, identityField: string): string | null {
  if (!isValueRecord(element)) {
    return null;
  }
  const identity = element[identityField];
  return typeof identity === "string" || typeof identity === "number" ? String(identity) : null;
}

function isValueRecord(
  value: ConfigurationValue | undefined,
): value is { readonly [key: string]: ConfigurationValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
