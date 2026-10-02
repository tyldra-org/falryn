import { createCuratedCatalogs } from "../../application/extensions/curated-catalogs.ts";
import {
  createPackageSuggestionResolver,
  type PackageSuggestionResolver,
} from "../../application/extensions/package-suggestions.ts";
import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import {
  type ConfigurationGenerationRecord,
  type ConfigurationValues,
  isUnreadSource,
} from "../../domain/configuration/index.ts";
import type { CuratedCatalogStore } from "../../domain/extensions/curated-catalog.ts";
import {
  DEFAULT_PACKAGE_SUGGESTION_PREFERENCES,
  PACKAGE_SUGGESTION_PROPOSALS_KEY,
  PACKAGE_SUGGESTIONS_KEY,
  type PackageSuggestionPreferences,
  packageSuggestionPreferencesSchema,
  packageSuggestionProposalsSchema,
} from "../../domain/extensions/package-suggestion.ts";
import { FALRYN_VERSION } from "../version.ts";
import { marketplaceSources } from "./marketplace-configuration.ts";

/**
 * Suggestion sources are opted in only in user configuration. A project can propose
 * sources for the user to review; a proposal is listed and enables nothing.
 */
export const PACKAGE_SUGGESTION_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: PACKAGE_SUGGESTIONS_KEY,
    summary:
      "Marketplaces opted in for package suggestions, and dismissed suggestions. Suggestions never install anything.",
    objectSchema: packageSuggestionPreferencesSchema,
    defaultValue: DEFAULT_PACKAGE_SUGGESTION_PREFERENCES,
    scopes: ["user"],
    applicationClass: "next-operation",
    sensitivity: "public",
  }),
  objectKey({
    path: PACKAGE_SUGGESTION_PROPOSALS_KEY,
    summary:
      "Marketplaces a project proposes for package suggestions. Shown for review; only user configuration enables one.",
    objectSchema: packageSuggestionProposalsSchema,
    defaultValue: { sources: [] },
    scopes: ["project"],
    applicationClass: "next-operation",
    sensitivity: "public",
  }),
];

/** Current preferences, or null when any configuration source could not be read. */
export function packageSuggestionPreferences(
  values: ConfigurationValues,
  record: ConfigurationGenerationRecord | null,
): PackageSuggestionPreferences | null {
  if (record === null || record.sources.some(isUnreadSource)) return null;
  const parsed = packageSuggestionPreferencesSchema.safeParse(
    values[PACKAGE_SUGGESTIONS_KEY] ?? DEFAULT_PACKAGE_SUGGESTION_PREFERENCES,
  );
  return parsed.success ? parsed.data : null;
}

/** Sources the project proposes; never read as enabled. */
export function packageSuggestionProposals(values: ConfigurationValues): readonly string[] {
  const parsed = packageSuggestionProposalsSchema.safeParse(
    values[PACKAGE_SUGGESTION_PROPOSALS_KEY] ?? { sources: [] },
  );
  return parsed.success ? parsed.data.sources : [];
}

export const HOST_FACTS = () => ({
  falryn: FALRYN_VERSION,
  bun: Bun.version,
  os: process.platform,
  arch: process.arch,
});

/**
 * A resolver over the product database's stored catalogs and the configuration in
 * force when it is read. Reading never fetches a marketplace.
 */
export function createConfiguredSuggestionResolver(options: {
  readonly store: CuratedCatalogStore;
  readonly now: () => number;
  readonly configuration: () => {
    readonly values: ConfigurationValues;
    readonly record: ConfigurationGenerationRecord | null;
  };
}): PackageSuggestionResolver {
  const marketplaces = () => {
    const current = options.configuration();
    return marketplaceSources(current.values, current.record);
  };
  return createPackageSuggestionResolver({
    catalogs: createCuratedCatalogs({
      store: options.store,
      now: options.now,
      host: HOST_FACTS(),
      marketplaces,
    }),
    preferences: () => {
      const current = options.configuration();
      return packageSuggestionPreferences(current.values, current.record);
    },
    marketplaces,
  });
}
