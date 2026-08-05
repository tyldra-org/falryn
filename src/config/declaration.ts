/**
 * How a key is declared, and how a rejected value becomes an issue.
 *
 * Each builder produces a descriptor and the Zod 4 type that validates values
 * for it, from one input, so the two can never disagree: a key whose descriptor
 * says `minimum: 1` is validated by a schema built from that same number.
 *
 * The translation from a Zod issue to a `ConfigurationIssue` deliberately reads
 * only the issue's *structural* fields — its code, its path, and the bound or
 * option list it violated. Zod's rendered message is never used, because a
 * message is where a library eventually decides to include the received value.
 */

import { z } from "zod";

import {
  type ConfigurationAlias,
  type ConfigurationApplicationClass,
  type ConfigurationDeprecation,
  type ConfigurationIssue,
  type ConfigurationKeyDescriptor,
  type ConfigurationKeyPath,
  type ConfigurationLimit,
  type ConfigurationMergeBehavior,
  type ConfigurationScope,
  type ConfigurationSensitivity,
  type ConfigurationUnit,
  type ConfigurationValue,
  type ConfigurationValueType,
  CREDENTIAL_STORE_KINDS,
  type CredentialStoreKind,
  configurationKeyPath,
  err,
  MAX_CONFIGURATION_KEY_PATH_LENGTH,
  MAX_CREDENTIAL_LABEL_LENGTH,
  MAX_CREDENTIAL_LOCATOR_LENGTH,
  ok,
  type Result,
  UNLIMITED,
} from "../domain/index.ts";
import { CONFIGURATION_SCHEMA_VERSION } from "./schema-family.ts";

/** A descriptor with the validator that enforces it. */
export type ConfigurationKeyDeclaration = {
  readonly descriptor: ConfigurationKeyDescriptor;
  /** The Zod 4 type for this key's raw JSON value. */
  readonly schema: z.ZodType;
  validate(raw: unknown): Result<ConfigurationValue, readonly ConfigurationIssue[]>;
};

/** Fields every key declares regardless of its shape. */
type CommonInput = {
  readonly path: string;
  readonly summary: string;
  readonly scopes: readonly ConfigurationScope[];
  readonly applicationClass: ConfigurationApplicationClass;
  readonly sensitivity?: ConfigurationSensitivity;
  readonly environmentVariable?: string | null;
  readonly aliases?: readonly ConfigurationAlias[];
  readonly deprecation?: ConfigurationDeprecation | null;
  readonly crossFieldDependencies?: readonly ConfigurationKeyPath[];
  readonly introducedInSchemaVersion?: number;
  readonly computedDefault?: boolean;
};

type DescriptorShape = {
  readonly valueType: ConfigurationValueType;
  readonly unit: ConfigurationUnit | null;
  readonly defaultValue: ConfigurationValue;
  readonly allowedValues: readonly string[] | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly merge: ConfigurationMergeBehavior;
};

function describe(input: CommonInput, shape: DescriptorShape): ConfigurationKeyDescriptor {
  return {
    path: configurationKeyPath(input.path),
    summary: input.summary,
    valueType: shape.valueType,
    unit: shape.unit,
    defaultValue: shape.defaultValue,
    computedDefault: input.computedDefault ?? false,
    allowedValues: shape.allowedValues,
    minimum: shape.minimum,
    maximum: shape.maximum,
    scopes: input.scopes,
    merge: shape.merge,
    sensitivity: input.sensitivity ?? "public",
    applicationClass: input.applicationClass,
    environmentVariable: input.environmentVariable ?? null,
    aliases: input.aliases ?? [],
    deprecation: input.deprecation ?? null,
    crossFieldDependencies: input.crossFieldDependencies ?? [],
    introducedInSchemaVersion: input.introducedInSchemaVersion ?? CONFIGURATION_SCHEMA_VERSION,
  };
}

/** Maps a Zod error onto issues, given the declaration that rejected it. */
type IssueMapper = (
  descriptor: ConfigurationKeyDescriptor,
  error: z.ZodError,
  raw: unknown,
) => readonly ConfigurationIssue[];

function declare(
  descriptor: ConfigurationKeyDescriptor,
  schema: z.ZodType,
  mapIssues: IssueMapper = mapZodIssues,
): ConfigurationKeyDeclaration {
  return {
    descriptor,
    schema,
    validate(raw: unknown): Result<ConfigurationValue, readonly ConfigurationIssue[]> {
      const result = schema.safeParse(raw);
      if (result.success) {
        return ok(result.data as ConfigurationValue);
      }
      return err(mapIssues(descriptor, result.error, raw));
    },
  };
}

function boundPath(path: string): string {
  return path.length > MAX_CONFIGURATION_KEY_PATH_LENGTH
    ? path.slice(0, MAX_CONFIGURATION_KEY_PATH_LENGTH)
    : path;
}

function issuePath(
  descriptor: ConfigurationKeyDescriptor,
  segments: readonly PropertyKey[],
): string {
  const suffix = segments.map((segment) => String(segment)).join(".");
  return boundPath(suffix.length === 0 ? descriptor.path : `${descriptor.path}.${suffix}`);
}

/** Zod's expected-type names, narrowed onto the declared vocabulary. */
function expectedTypeFor(
  descriptor: ConfigurationKeyDescriptor,
  expected: unknown,
): ConfigurationValueType {
  switch (expected) {
    case "string":
      return "string";
    case "number":
    case "int":
      return "integer";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return descriptor.valueType === "map" ? "map" : "object";
    default:
      return descriptor.valueType;
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The general translation.
 *
 * A bound reported by Zod wins over the descriptor's, because a nested value —
 * a byte count inside a map entry — carries a bound the top-level descriptor
 * never declared.
 */
export function mapZodIssues(
  descriptor: ConfigurationKeyDescriptor,
  error: z.ZodError,
): readonly ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  for (const issue of error.issues) {
    const path = issuePath(descriptor, issue.path);
    switch (issue.code) {
      case "invalid_type":
        issues.push({
          kind: "invalid-type",
          severity: "error",
          path,
          expected: expectedTypeFor(descriptor, issue.expected),
        });
        break;
      case "too_small":
        issues.push({
          kind: "out-of-range",
          severity: "error",
          path,
          unit: descriptor.unit,
          minimum: finiteOrNull(issue.minimum) ?? descriptor.minimum,
          maximum: descriptor.maximum,
        });
        break;
      case "too_big":
        issues.push({
          kind: "out-of-range",
          severity: "error",
          path,
          unit: descriptor.unit,
          minimum: descriptor.minimum,
          maximum: finiteOrNull(issue.maximum) ?? descriptor.maximum,
        });
        break;
      case "unrecognized_keys":
        for (const key of issue.keys) {
          issues.push({
            kind: "unknown-key",
            severity: "error",
            path: boundPath(`${path}.${key}`),
          });
        }
        break;
      case "invalid_key":
        issues.push({ kind: "unknown-key", severity: "error", path });
        break;
      case "invalid_value":
        issues.push({
          kind: "invalid-value",
          severity: "error",
          path,
          allowed: issue.values.map((value) => String(value)),
        });
        break;
      default:
        issues.push({
          kind: "invalid-value",
          severity: "error",
          path,
          allowed: descriptor.allowedValues ?? [],
        });
        break;
    }
  }
  return issues;
}

/**
 * A yes or no.
 *
 * Boolean rather than a tri-state, and #392 is where that was decided: the
 * capability record already answers what a terminal *can* do, so a setting only
 * has to express what a user *wants*. A third state would be a second place to
 * say "ask the terminal", which the record already is.
 *
 * `coerce` in `./bridges.ts` accepts exactly `true` and `false` for this type,
 * so an environment variable set to `0`, `off`, or `no` is an invalid value
 * reported as an issue — not silently read as false. Documentation that tells a
 * user to type anything else is documentation that does not work.
 *
 * Which is why the two accepted spellings are declared rather than left `null`.
 * The invalid-value issue carries `descriptor.allowedValues`, so a key that
 * declares none produces "a configuration value is not one of the allowed
 * values" followed by an empty list — telling a user their value is wrong and
 * not what would be right. `enumKey` supplies its list for exactly this reason.
 * Coercion is unaffected: the `boolean` branch tests the two literals itself and
 * never consults this.
 */
export function booleanKey(
  input: CommonInput & { readonly defaultValue: boolean },
): ConfigurationKeyDeclaration {
  const descriptor = describe(input, {
    valueType: "boolean",
    unit: null,
    defaultValue: input.defaultValue,
    allowedValues: ["true", "false"],
    minimum: null,
    maximum: null,
    merge: { kind: "replace" },
  });
  return declare(descriptor, z.boolean());
}

/** An enumerated value. */
export function enumKey(
  input: CommonInput & {
    readonly allowed: readonly [string, ...string[]];
    readonly defaultValue: string;
  },
): ConfigurationKeyDeclaration {
  const descriptor = describe(input, {
    valueType: "enum",
    unit: null,
    defaultValue: input.defaultValue,
    allowedValues: input.allowed,
    minimum: null,
    maximum: null,
    merge: { kind: "replace" },
  });
  return declare(descriptor, z.literal(input.allowed));
}

/** A counted integer with an explicit unit and inclusive bounds. */
export function integerKey(
  input: CommonInput & {
    readonly unit: ConfigurationUnit;
    readonly minimum: number;
    readonly maximum: number;
    readonly defaultValue: number;
  },
): ConfigurationKeyDeclaration {
  const descriptor = describe(input, {
    valueType: "integer",
    unit: input.unit,
    defaultValue: input.defaultValue,
    allowedValues: null,
    minimum: input.minimum,
    maximum: input.maximum,
    merge: { kind: "replace" },
  });
  return declare(descriptor, z.int().min(input.minimum).max(input.maximum));
}

/**
 * A bound that may be lifted entirely.
 *
 * `"unlimited"` is spelled out rather than encoded as `0` or a missing value,
 * so the three of them stay three different statements. A number outside the
 * declared range is an error rather than a silent clamp.
 */
export function limitKey(
  input: CommonInput & {
    readonly unit: ConfigurationUnit;
    readonly minimum: number;
    readonly maximum: number;
    readonly defaultValue: ConfigurationLimit;
  },
): ConfigurationKeyDeclaration {
  const descriptor = describe(input, {
    valueType: "limit",
    unit: input.unit,
    defaultValue: input.defaultValue,
    allowedValues: [UNLIMITED],
    minimum: input.minimum,
    maximum: input.maximum,
    merge: { kind: "replace" },
  });
  return declare(descriptor, limitSchema(input), mapLimitIssues);
}

export function limitSchema(bounds: {
  readonly minimum: number;
  readonly maximum: number;
}): z.ZodType {
  return z.union([z.int().min(bounds.minimum).max(bounds.maximum), z.literal(UNLIMITED)]);
}

/**
 * A limit's rejection, reported against the limit rather than the union.
 *
 * The generic mapper would report a union failure, which describes the schema's
 * shape instead of the author's mistake. A limit has exactly two ways to be
 * wrong — not a limit at all, or a number outside the range — and saying which
 * is the whole value of the diagnostic.
 */
export const mapLimitIssues: IssueMapper = (descriptor, error, raw) => {
  const nested = error.issues.some((issue) => issue.path.length > 0);
  if (nested) {
    return mapZodIssues(descriptor, error);
  }
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    return [{ kind: "invalid-type", severity: "error", path: descriptor.path, expected: "limit" }];
  }
  return [
    {
      kind: "out-of-range",
      severity: "error",
      path: descriptor.path,
      unit: descriptor.unit,
      minimum: descriptor.minimum,
      maximum: descriptor.maximum,
    },
  ];
};

/**
 * A filesystem path override.
 *
 * `null` is the declared default and means "resolve from platform conventions".
 * It is a computed default, so inspection shows an unset key as unset rather
 * than as a path this build invented.
 */
export function pathOverrideKey(
  input: CommonInput & { readonly maxLength: number },
): ConfigurationKeyDeclaration {
  const descriptor = describe(
    { ...input, computedDefault: true },
    {
      valueType: "string",
      unit: null,
      defaultValue: null,
      allowedValues: null,
      minimum: null,
      maximum: input.maxLength,
      merge: { kind: "replace" },
    },
  );
  // `.nullable()` rather than a hand-built union: a union reports that the
  // union failed, while this reports that a string was expected, which is what
  // the author needs to read.
  return declare(descriptor, z.string().min(1).max(input.maxLength).nullable());
}

/**
 * A map whose keys come from a declared set.
 *
 * Merging happens one level down: a later layer's entries are folded into the
 * earlier map, and an entry itself replaces. Anything deeper would be the
 * generic deep merge this contract exists to prevent.
 */
export function mapKey(
  input: CommonInput & {
    readonly allowedKeys: readonly [string, ...string[]];
    readonly valueSchema: z.ZodType;
    readonly defaultValue: { readonly [key: string]: ConfigurationValue };
  },
): ConfigurationKeyDeclaration {
  const shape: Record<string, z.ZodType> = {};
  for (const key of input.allowedKeys) {
    shape[key] = input.valueSchema.optional();
  }
  const descriptor = describe(input, {
    valueType: "map",
    unit: null,
    defaultValue: input.defaultValue,
    allowedValues: input.allowedKeys,
    minimum: null,
    maximum: null,
    merge: { kind: "merge-map" },
  });
  return declare(descriptor, z.strictObject(shape));
}

/**
 * An array whose elements are identified by a declared field.
 *
 * Two elements sharing that field are the same element, which is what lets a
 * later layer amend one entry instead of replacing the list. A repeat inside
 * one document is rejected: it makes the identity ambiguous before merging even
 * starts.
 */
export function identifiedArrayKey(
  input: CommonInput & {
    readonly identityField: string;
    readonly elementSchema: z.ZodObject;
    readonly defaultValue: readonly ConfigurationValue[];
    readonly maximumItems: number;
  },
): ConfigurationKeyDeclaration {
  const descriptor = describe(input, {
    valueType: "array",
    unit: "items",
    defaultValue: input.defaultValue,
    allowedValues: null,
    minimum: 0,
    maximum: input.maximumItems,
    merge: { kind: "merge-by-identity", identityField: input.identityField },
  });
  const schema = z.array(input.elementSchema).max(input.maximumItems);
  const declaration = declare(descriptor, schema);
  return {
    ...declaration,
    validate(raw: unknown): Result<ConfigurationValue, readonly ConfigurationIssue[]> {
      const parsed = declaration.validate(raw);
      if (!parsed.ok) {
        return parsed;
      }
      const seen = new Set<string>();
      const elements = parsed.value as readonly { readonly [key: string]: ConfigurationValue }[];
      for (const element of elements) {
        const identity = String(element[input.identityField]);
        if (seen.has(identity)) {
          return err([
            {
              kind: "duplicate-identity",
              severity: "error",
              path: descriptor.path,
              identityField: input.identityField,
            },
          ]);
        }
        seen.add(identity);
      }
      return parsed;
    },
  };
}

/**
 * A key that holds a credential reference, or nothing.
 *
 * Three constraints are applied here rather than left to each author, because
 * getting any of them wrong puts a secret in a file:
 *
 * - **The sensitivity is forced**, so a credential key cannot be declared
 *   public by omission and rendered in full by the projection that follows the
 *   declaration.
 * - **The `project` scope is refused at declaration time.** A checked-in
 *   project file is the single worst place for a credential, and a key that
 *   cannot be set there cannot be set there by accident.
 * - **A value that is not a reference is a named diagnostic**, not a type
 *   error. `"sk-live-…"` written where a reference belongs is a credential in a
 *   file, and it is worth saying so exactly.
 *
 * The default is `null` — no credential configured — because a declared
 * placeholder locator would be a reference pointing at nothing.
 */
export function credentialReferenceKey(
  input: Omit<CommonInput, "sensitivity"> & {
    readonly storeKinds?: readonly [CredentialStoreKind, ...CredentialStoreKind[]];
  },
): ConfigurationKeyDeclaration {
  if (input.scopes.includes("project")) {
    throw new Error(`credential key may not be set from project scope: ${input.path}`);
  }
  const storeKinds = input.storeKinds ?? CREDENTIAL_STORE_KINDS;
  const descriptor = describe(
    { ...input, sensitivity: "credential-reference" },
    {
      valueType: "object",
      unit: null,
      defaultValue: null,
      allowedValues: [...storeKinds],
      minimum: null,
      maximum: null,
      merge: { kind: "replace" },
    },
  );
  // `.nullable()` rather than a union with `z.null()`, for the reason
  // `pathOverrideKey` gives: a union reports that the union failed, which
  // describes the schema instead of the mistake. A secret smuggled in beside
  // the reference has to report itself as an unknown key.
  const schema = z
    .strictObject({
      storeKind: z.literal(storeKinds),
      locator: z.string().min(1).max(MAX_CREDENTIAL_LOCATOR_LENGTH),
      consumer: z.string().min(1).max(MAX_CREDENTIAL_LABEL_LENGTH),
      accountLabel: z.union([z.string().min(1).max(MAX_CREDENTIAL_LABEL_LENGTH), z.null()]),
    })
    .nullable();
  const declaration = declare(descriptor, schema);

  return {
    ...declaration,
    validate(raw: unknown): Result<ConfigurationValue, readonly ConfigurationIssue[]> {
      // A scalar where a reference belongs is a secret someone pasted in, not a
      // shape mistake. Checked before Zod so the diagnostic says which it is.
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        return err([
          {
            kind: "plaintext-credential",
            severity: "error",
            path: descriptor.path,
            expectedStoreKinds: storeKinds,
          },
        ]);
      }
      return declaration.validate(raw);
    },
  };
}

/** A fixed-shape object that replaces wholesale. */
export function objectKey(
  input: CommonInput & {
    readonly objectSchema: z.ZodType;
    readonly defaultValue: ConfigurationValue;
  },
): ConfigurationKeyDeclaration {
  const descriptor = describe(input, {
    valueType: "object",
    unit: null,
    defaultValue: input.defaultValue,
    allowedValues: null,
    minimum: null,
    maximum: null,
    merge: { kind: "replace" },
  });
  return declare(descriptor, input.objectSchema);
}
