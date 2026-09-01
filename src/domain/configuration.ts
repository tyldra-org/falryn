/**
 * The configuration contract other areas consume.
 *
 * This module owns *what a configuration key is* — its path, its declared
 * merge behavior, its sensitivity, when a change to it applies — and the port
 * through which a registry answers those questions. It owns no file, no layer,
 * and no precedence: reading and composing sources is the composition owner's
 * job, and it depends on this contract rather than the other way round.
 *
 * Three rules the types enforce rather than document:
 *
 * - **Merge behavior is declared per key.** There is no generic deep merge to
 *   fall back to, so a composer cannot invent one for a key whose author never
 *   decided what merging it means.
 * - **A limit is either a bounded number or explicitly unlimited.** Zero,
 *   negative, missing, and unlimited stay four distinct facts, so `0` can never
 *   quietly mean "no limit".
 * - **A validation issue reports structure only** — a path, an issue kind, and
 *   the constraint that was violated. It never carries the rejected value, so a
 *   malformed configuration file containing a token is safe to log and export.
 */

import type { ConfigurationApplicationClass } from "./event.ts";
import type { Brand } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";

/**
 * Where a value may be set.
 *
 * A key that omits a scope cannot be set there at all: a project checkout must
 * not be able to relocate the machine's data roots merely by being opened.
 */
export const CONFIGURATION_SCOPES = ["user", "project", "profile", "environment", "cli"] as const;

export type ConfigurationScope = (typeof CONFIGURATION_SCOPES)[number];

export function isConfigurationScope(value: unknown): value is ConfigurationScope {
  return typeof value === "string" && (CONFIGURATION_SCOPES as readonly string[]).includes(value);
}

/** What supplied a value. Built-in defaults are a source, not an absence. */
export const CONFIGURATION_SOURCE_KINDS = [
  "built-in-default",
  "user-file",
  "project-file",
  "profile",
  "environment",
  "cli-override",
] as const;

export type ConfigurationSourceKind = (typeof CONFIGURATION_SOURCE_KINDS)[number];

/**
 * The scope a source kind supplies.
 *
 * `built-in-default` has no scope: it is the value a key has when no scope set
 * it, so scope availability never applies to it.
 */
export function scopeForSourceKind(kind: ConfigurationSourceKind): ConfigurationScope | null {
  switch (kind) {
    case "built-in-default":
      return null;
    case "user-file":
      return "user";
    case "project-file":
      return "project";
    case "profile":
      return "profile";
    case "environment":
      return "environment";
    case "cli-override":
      return "cli";
  }
}

/**
 * How much of a value may be shown.
 *
 * `credential-reference` is not a weaker `sensitive`: a reference is safe to
 * display in outline — store kind, consumer, account label — while its locator
 * is not. Inspection shows that a credential is configured and healthy, never
 * what it is.
 */
export const CONFIGURATION_SENSITIVITIES = ["public", "sensitive", "credential-reference"] as const;

export type ConfigurationSensitivity = (typeof CONFIGURATION_SENSITIVITIES)[number];

/** Units a limit is expressed in. A limit without a unit is not declarable. */
export const CONFIGURATION_UNITS = ["milliseconds", "bytes", "items", "concurrency"] as const;

export type ConfigurationUnit = (typeof CONFIGURATION_UNITS)[number];

/** The shape a key expects, reported when the shape is wrong. */
export const CONFIGURATION_VALUE_TYPES = [
  "string",
  "integer",
  "boolean",
  "enum",
  "limit",
  "map",
  "array",
  "object",
] as const;

export type ConfigurationValueType = (typeof CONFIGURATION_VALUE_TYPES)[number];

/** Any value a key may hold, in its JSON representation. */
export type ConfigurationValue =
  | string
  | number
  | boolean
  | null
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };

/** Effective values, keyed by canonical dotted path. */
export type ConfigurationValues = Readonly<Record<string, ConfigurationValue>>;

/**
 * The explicit spelling of "no bound".
 *
 * A bounded limit is a positive integer. Unlimited says so in words, so a
 * reader never has to decide whether `0` meant none, unset, or everything.
 */
export const UNLIMITED = "unlimited";

export type ConfigurationLimit = number | typeof UNLIMITED;

export function isUnlimited(limit: ConfigurationLimit): limit is typeof UNLIMITED {
  return limit === UNLIMITED;
}

/**
 * How a later layer combines with an earlier one.
 *
 * Declared per key so composition never guesses. `merge-by-identity` names the
 * field that identifies an element; two elements sharing it are the same
 * element, and everything else replaces.
 */
export type ConfigurationMergeBehavior =
  | { readonly kind: "replace" }
  | { readonly kind: "merge-map" }
  | { readonly kind: "merge-by-identity"; readonly identityField: string };

/** A canonical dotted key path, such as `diagnostics.level`. */
export type ConfigurationKeyPath = Brand<string, "ConfigurationKeyPath">;

/** Longest key path, in UTF-16 code units. Also bounds a rejected unknown key. */
export const MAX_CONFIGURATION_KEY_PATH_LENGTH = 120;

/**
 * At least two camelCase segments.
 *
 * A single segment would be a group name with no key under it, and the group
 * prefix is what keeps two owners from colliding on a bare word like `level`.
 */
const LEGAL_KEY_PATH = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/;

export type ConfigurationKeyPathErrorCode =
  | "key-path-empty"
  | "key-path-too-long"
  | "key-path-malformed"
  | "key-path-not-a-string";

export type ConfigurationKeyPathError = {
  readonly kind: "configuration-key-path";
  readonly code: ConfigurationKeyPathErrorCode;
};

/** Validates an untrusted key path. Never echoes the rejected text. */
export function parseConfigurationKeyPath(
  value: unknown,
): Result<ConfigurationKeyPath, ConfigurationKeyPathError> {
  if (typeof value !== "string") {
    return err({ kind: "configuration-key-path", code: "key-path-not-a-string" });
  }
  if (value.length === 0) {
    return err({ kind: "configuration-key-path", code: "key-path-empty" });
  }
  if (value.length > MAX_CONFIGURATION_KEY_PATH_LENGTH) {
    return err({ kind: "configuration-key-path", code: "key-path-too-long" });
  }
  if (!LEGAL_KEY_PATH.test(value)) {
    return err({ kind: "configuration-key-path", code: "key-path-malformed" });
  }
  return ok(value as ConfigurationKeyPath);
}

/**
 * Validates a trusted key path and throws on rejection.
 *
 * Use only where an invalid path is a defect, such as a declaration literal.
 */
export function configurationKeyPath(value: string): ConfigurationKeyPath {
  const parsed = parseConfigurationKeyPath(value);
  if (!parsed.ok) {
    throw new Error(`invalid configuration key path: ${parsed.error.code}`);
  }
  return parsed.value;
}

/** Stores a credential reference may point into. */
export const CREDENTIAL_STORE_KINDS = [
  "operating-system-keychain",
  "provider-login",
  "environment",
  "local-file",
] as const;

export type CredentialStoreKind = (typeof CREDENTIAL_STORE_KINDS)[number];

/**
 * A pointer to a secret, never the secret.
 *
 * Declared here so a key can be typed as holding one and rendered with its
 * locator withheld. Resolving it — reaching a keychain, a login store, or an
 * environment variable — belongs to the credential owner, not to this contract.
 */
export type CredentialReference = {
  readonly storeKind: CredentialStoreKind;
  /** Opaque locator inside the store. Withheld from every rendering. */
  readonly locator: string;
  /** Which provider or integration may resolve it. */
  readonly consumer: string;
  readonly accountLabel: string | null;
};

/** A spelling that resolves to a canonical path. Always a deprecated one. */
export type ConfigurationAlias = {
  readonly path: ConfigurationKeyPath;
  readonly deprecatedInSchemaVersion: number;
  readonly removedInSchemaVersion: number | null;
};

/** A canonical key that is itself on the way out. */
export type ConfigurationDeprecation = {
  readonly replacement: ConfigurationKeyPath | null;
  readonly deprecatedInSchemaVersion: number;
  readonly removedInSchemaVersion: number | null;
};

/**
 * Everything declared about one key.
 *
 * Data only: the Zod type that validates a value stays with the registry, so
 * the domain contract carries no schema-library type and a consumer reading a
 * descriptor gets facts rather than a parser.
 */
export type ConfigurationKeyDescriptor = {
  readonly path: ConfigurationKeyPath;
  /** One line, written for documentation. Carries no user data. */
  readonly summary: string;
  readonly valueType: ConfigurationValueType;
  readonly unit: ConfigurationUnit | null;
  readonly defaultValue: ConfigurationValue;
  /**
   * Whether the effective default is computed at load time.
   *
   * `defaultValue` is still the declared placeholder — `null` for a path that
   * resolves from platform conventions — so inspection can show what the key
   * holds before anything computes it.
   */
  readonly computedDefault: boolean;
  /** Allowed values for an enum key, in declaration order. */
  readonly allowedValues: readonly string[] | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly scopes: readonly ConfigurationScope[];
  readonly merge: ConfigurationMergeBehavior;
  readonly sensitivity: ConfigurationSensitivity;
  readonly applicationClass: ConfigurationApplicationClass;
  /** Environment variable this key reads, or `null` when it reads none. */
  readonly environmentVariable: string | null;
  readonly aliases: readonly ConfigurationAlias[];
  readonly deprecation: ConfigurationDeprecation | null;
  /** Keys whose values this key is validated against after composition. */
  readonly crossFieldDependencies: readonly ConfigurationKeyPath[];
  readonly introducedInSchemaVersion: number;
};

export type ConfigurationIssueSeverity = "error" | "warning";

/**
 * A validation finding.
 *
 * Every variant reports a path and the constraint that was violated. None
 * carries the rejected value, and the constraint fields — expected type,
 * bounds, allowed values, scopes — come from the declaration rather than from
 * the input.
 */
export type ConfigurationIssue =
  /** Both the current and legacy user configuration homes contain data. */
  | {
      readonly kind: "configuration-home-conflict";
      readonly severity: "error";
      readonly path: string;
      readonly legacyPath: string;
    }
  /** A configuration home could not be inspected safely. */
  | {
      readonly kind: "configuration-home-unavailable";
      readonly severity: "error";
      readonly path: string;
      readonly code: string;
    }
  /** A key no declaration owns. Never mapped onto a similar known key. */
  | { readonly kind: "unknown-key"; readonly severity: "error"; readonly path: string }
  | {
      readonly kind: "invalid-type";
      readonly severity: "error";
      readonly path: string;
      readonly expected: ConfigurationValueType;
    }
  | {
      readonly kind: "out-of-range";
      readonly severity: "error";
      readonly path: string;
      readonly unit: ConfigurationUnit | null;
      readonly minimum: number | null;
      readonly maximum: number | null;
    }
  | {
      readonly kind: "invalid-value";
      readonly severity: "error";
      readonly path: string;
      readonly allowed: readonly string[];
    }
  /** The key exists but may not be set from this scope. */
  | {
      readonly kind: "scope-unavailable";
      readonly severity: "error";
      readonly path: string;
      readonly scope: ConfigurationScope;
      readonly availableScopes: readonly ConfigurationScope[];
    }
  | {
      readonly kind: "duplicate-identity";
      readonly severity: "error";
      readonly path: string;
      readonly identityField: string;
    }
  /** An impossible combination, caught after composition rather than at use. */
  | {
      readonly kind: "cross-field-conflict";
      readonly severity: "error";
      readonly path: string;
      readonly rule: string;
      readonly relatedPaths: readonly ConfigurationKeyPath[];
    }
  /**
   * A secret was written where a reference belongs.
   *
   * Named separately from `invalid-type` because the two need different
   * answers: a wrong type is a typo, and this is a credential now sitting in a
   * file that may be committed. It is refused rather than coerced, and — like
   * every issue here — it reports the constraint rather than what was written.
   */
  | {
      readonly kind: "plaintext-credential";
      readonly severity: "error";
      readonly path: string;
      readonly expectedStoreKinds: readonly CredentialStoreKind[];
    }
  | { readonly kind: "invalid-schema-version"; readonly severity: "error"; readonly path: string }
  | {
      readonly kind: "unsupported-schema-version";
      readonly severity: "error";
      readonly path: string;
      readonly observedSchemaVersion: number;
      readonly minimumCompatibleVersion: number;
      readonly readerSchemaVersion: number;
    }
  | {
      readonly kind: "retired-schema-version";
      readonly severity: "error";
      readonly path: string;
      readonly observedSchemaVersion: number;
      readonly minimumSupportedVersion: number;
    }
  /** A deprecated spelling was accepted and rewritten to its canonical path. */
  | {
      readonly kind: "alias-resolved";
      readonly severity: "warning";
      readonly path: string;
      readonly canonical: ConfigurationKeyPath;
    }
  | {
      readonly kind: "deprecated-key";
      readonly severity: "warning";
      readonly path: string;
      readonly replacement: ConfigurationKeyPath | null;
      readonly removedInSchemaVersion: number | null;
    }
  /** A key from a newer producer, dropped because this build cannot use it. */
  | {
      readonly kind: "ignored-forward-key";
      readonly severity: "warning";
      readonly path: string;
      readonly observedSchemaVersion: number;
      readonly readerSchemaVersion: number;
    };

export type ConfigurationIssueKind = ConfigurationIssue["kind"];

/** Whether an issue prevents the document from being used. */
export function isBlockingIssue(issue: ConfigurationIssue): boolean {
  return issue.severity === "error";
}

export function blockingIssues(
  issues: readonly ConfigurationIssue[],
): readonly ConfigurationIssue[] {
  return issues.filter(isBlockingIssue);
}

/** Which layer a document was read from. */
export type ConfigurationLayerContext = {
  readonly scope: ConfigurationScope;
  readonly sourceKind: ConfigurationSourceKind;
};

/**
 * The outcome of validating one document.
 *
 * A successful result may still carry warnings — a resolved alias and a
 * deprecated key are both accepted and both worth reporting.
 */
export type ConfigurationValidationResult =
  | {
      readonly ok: true;
      /** Only the keys this document set, under their canonical paths. */
      readonly values: ConfigurationValues;
      readonly issues: readonly ConfigurationIssue[];
    }
  | { readonly ok: false; readonly issues: readonly ConfigurationIssue[] };

/** How a spelling resolved against the registry. */
export type ConfigurationKeyResolution =
  | {
      readonly kind: "known";
      readonly descriptor: ConfigurationKeyDescriptor;
      /** The deprecated spelling used, or `null` when the canonical path was. */
      readonly viaAlias: ConfigurationAlias | null;
    }
  | { readonly kind: "unknown" };

/**
 * Redaction, injected rather than imported.
 *
 * The runtime's redactor lives in the application layer, and configuration
 * depends on domain ports only. Passing it in keeps the dependency direction
 * intact without writing a second set of redaction rules — two redactors is one
 * more than can be kept correct.
 */
export type SensitiveValueRedactor = {
  /** What a withheld value renders as. */
  readonly placeholder: string;
  redactText(text: string, maxLength?: number): string;
  /** Whether a field name means the value beside it is a credential. */
  isSecretName(key: string): boolean;
};

/**
 * The registry other areas consume.
 *
 * It answers what a key is, what it defaults to, whether a document is valid,
 * and how a value may be shown. It reads nothing and composes nothing.
 */
export type ConfigurationRegistryPort = {
  readonly schemaFamily: string;
  /** Version this build writes and can fully interpret. */
  readonly schemaVersion: number;
  /** Oldest document version this build interprets. */
  readonly minimumSchemaVersion: number;
  keys(): readonly ConfigurationKeyDescriptor[];
  describe(path: string): ConfigurationKeyDescriptor | null;
  resolve(path: string): ConfigurationKeyResolution;
  /** Every declared key at its default. Complete by construction. */
  defaults(): ConfigurationValues;
  /** Validates one layer document without applying defaults. */
  validateLayer(
    document: unknown,
    context: ConfigurationLayerContext,
  ): ConfigurationValidationResult;
  /** Cross-field rules over a complete effective value. */
  crossValidate(values: ConfigurationValues): readonly ConfigurationIssue[];
  /** Layer validation, defaults, and cross-field rules in one pass. */
  validateComplete(
    document: unknown,
    context: ConfigurationLayerContext,
  ): ConfigurationValidationResult;
  /** A value as it may be displayed, with sensitive parts withheld. */
  render(path: string, value: ConfigurationValue): ConfigurationValue;
};
