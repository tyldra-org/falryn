/**
 * Fixture registries for shapes the v0.1 catalog has no consumer for.
 *
 * Test-only. Not re-exported from the configuration entrypoint and not imported
 * by product code.
 *
 * The declared merge shapes, aliases, deprecations, and sensitivity classes all
 * have to work before something needs them, or the first owner that needs one
 * discovers it is broken. Proving them here is the alternative to inventing a
 * product key of the right shape — a declared key whose consumer does not exist
 * is a claim about behavior that does not exist.
 */

import { z } from "zod";

import {
  type ConfigurationIssue,
  type ConfigurationValues,
  configurationKeyPath,
  type SensitiveValueRedactor,
} from "../domain/index.ts";
import {
  type ConfigurationKeyDeclaration,
  enumKey,
  identifiedArrayKey,
  integerKey,
  mapKey,
  objectKey,
} from "./declaration.ts";
import type { ConfigurationCrossFieldRule } from "./registry.ts";

/** A scalar that replaces on every layer. */
export const FIXTURE_SCALAR_KEY: ConfigurationKeyDeclaration = integerKey({
  path: "fixture.scalar",
  summary: "A scalar that a later layer replaces outright.",
  unit: "items",
  minimum: 0,
  maximum: 100,
  defaultValue: 10,
  scopes: ["user", "project", "profile", "environment", "cli"],
  applicationClass: "live",
});

/** A map that merges one level. */
export const FIXTURE_MAP_KEY: ConfigurationKeyDeclaration = mapKey({
  path: "fixture.map",
  summary: "A map whose entries a later layer folds into an earlier one.",
  allowedKeys: ["alpha", "beta"],
  valueSchema: z.strictObject({ weight: z.int().min(0).max(1_000) }),
  defaultValue: { alpha: { weight: 1 }, beta: { weight: 2 } },
  scopes: ["user", "project"],
  applicationClass: "next-turn",
});

/** An array whose elements are identified by a declared field. */
export const FIXTURE_IDENTIFIED_LIST_KEY: ConfigurationKeyDeclaration = identifiedArrayKey({
  path: "fixture.list",
  summary: "A list whose elements a later layer amends by identity.",
  identityField: "name",
  elementSchema: z.strictObject({ name: z.string().min(1).max(64), enabled: z.boolean() }),
  defaultValue: [],
  maximumItems: 16,
  scopes: ["user", "project"],
  applicationClass: "application-restart",
});

/** A key reached through a deprecated spelling. */
export const FIXTURE_ALIASED_KEY: ConfigurationKeyDeclaration = enumKey({
  path: "fixture.mode",
  summary: "A key that also answers to an older name.",
  allowed: ["fast", "careful"],
  defaultValue: "careful",
  scopes: ["user", "project"],
  applicationClass: "next-operation",
  aliases: [
    {
      path: configurationKeyPath("fixture.legacyMode"),
      deprecatedInSchemaVersion: 1,
      removedInSchemaVersion: 2,
    },
  ],
});

/** A canonical key that is itself on the way out. */
export const FIXTURE_DEPRECATED_KEY: ConfigurationKeyDeclaration = integerKey({
  path: "fixture.legacyBudget",
  summary: "A key whose replacement already exists.",
  unit: "items",
  minimum: 1,
  maximum: 10,
  defaultValue: 5,
  scopes: ["user"],
  applicationClass: "application-restart",
  deprecation: {
    replacement: configurationKeyPath("fixture.scalar"),
    deprecatedInSchemaVersion: 1,
    removedInSchemaVersion: 2,
  },
});

/** A value that is never displayed. */
export const FIXTURE_SENSITIVE_KEY: ConfigurationKeyDeclaration = objectKey({
  path: "fixture.secretBundle",
  summary: "A declared-sensitive value that no rendering shows.",
  objectSchema: z.strictObject({ token: z.string().min(1).max(256) }),
  defaultValue: { token: "unset" },
  sensitivity: "sensitive",
  scopes: ["user"],
  applicationClass: "application-restart",
});

/** A pointer to a secret, shown in outline only. */
export const FIXTURE_CREDENTIAL_KEY: ConfigurationKeyDeclaration = objectKey({
  path: "fixture.credential",
  summary: "A credential reference, displayed as presence rather than content.",
  objectSchema: z.strictObject({
    storeKind: z.literal([
      "operating-system-keychain",
      "provider-login",
      "environment",
      "local-file",
    ]),
    locator: z.string().min(1).max(256),
    consumer: z.string().min(1).max(64),
    accountLabel: z.union([z.string().min(1).max(64), z.null()]),
  }),
  defaultValue: {
    storeKind: "operating-system-keychain",
    locator: "unset",
    consumer: "fixture",
    accountLabel: null,
  },
  sensitivity: "credential-reference",
  scopes: ["user"],
  applicationClass: "application-restart",
});

/** A public key whose value can still carry a secret someone typed into it. */
export const FIXTURE_PUBLIC_TEXT_KEY: ConfigurationKeyDeclaration = objectKey({
  path: "fixture.endpoint",
  summary: "A public value whose text is still passed through the redactor.",
  objectSchema: z.strictObject({
    url: z.string().min(1).max(512),
    apiKey: z.string().min(1).max(256).optional(),
  }),
  defaultValue: { url: "https://example.invalid" },
  scopes: ["user"],
  applicationClass: "application-restart",
});

export const FIXTURE_KEYS: readonly ConfigurationKeyDeclaration[] = [
  FIXTURE_SCALAR_KEY,
  FIXTURE_MAP_KEY,
  FIXTURE_IDENTIFIED_LIST_KEY,
  FIXTURE_ALIASED_KEY,
  FIXTURE_DEPRECATED_KEY,
  FIXTURE_SENSITIVE_KEY,
  FIXTURE_CREDENTIAL_KEY,
  FIXTURE_PUBLIC_TEXT_KEY,
];

const SCALAR_PATH = configurationKeyPath("fixture.scalar");
const LEGACY_BUDGET_PATH = configurationKeyPath("fixture.legacyBudget");

/** A combination that is impossible only once both values are known. */
export const FIXTURE_CROSS_FIELD_RULE: ConfigurationCrossFieldRule = {
  id: "fixture.budget-fits-scalar",
  paths: [SCALAR_PATH, LEGACY_BUDGET_PATH],
  evaluate(values: ConfigurationValues): ConfigurationIssue | null {
    const scalar = values[SCALAR_PATH];
    const budget = values[LEGACY_BUDGET_PATH];
    if (typeof scalar !== "number" || typeof budget !== "number") {
      return null;
    }
    return budget > scalar
      ? {
          kind: "cross-field-conflict",
          severity: "error",
          path: LEGACY_BUDGET_PATH,
          rule: "fixture.budget-fits-scalar",
          relatedPaths: [LEGACY_BUDGET_PATH, SCALAR_PATH],
        }
      : null;
  },
};

/**
 * A redactor that withholds everything it is asked about.
 *
 * Used where a test needs to prove that rendering *consulted* the redactor,
 * separately from proving that the runtime's real rules are correct — which is
 * the real redactor's own test.
 */
export const MARKING_REDACTOR: SensitiveValueRedactor = {
  placeholder: "<withheld>",
  redactText: (text: string, maxLength = 300): string => text.slice(0, maxLength),
  isSecretName: (key: string): boolean => key === "apiKey",
};
