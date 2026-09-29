import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import {
  type ConfigurationGenerationRecord,
  type ConfigurationValues,
  isUnreadSource,
} from "../../domain/configuration/index.ts";
import {
  MARKETPLACES_KEY,
  type MarketplaceSource,
  marketplaceConfigurationSchema,
} from "../../domain/extensions/marketplace.ts";

export const MARKETPLACE_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: MARKETPLACES_KEY,
    summary:
      "User-configured marketplace catalog sources. Only an explicit refresh contacts one; listings grant nothing.",
    objectSchema: marketplaceConfigurationSchema,
    defaultValue: { sources: [] },
    scopes: ["user"],
    applicationClass: "next-operation",
    sensitivity: "sensitive",
  }),
];

/** Configured marketplaces, or null when any configuration source could not be read. */
export function marketplaceSources(
  values: ConfigurationValues,
  record: ConfigurationGenerationRecord | null,
): readonly MarketplaceSource[] | null {
  if (record === null || record.sources.some(isUnreadSource)) return null;
  const parsed = marketplaceConfigurationSchema.safeParse(
    values[MARKETPLACES_KEY] ?? { sources: [] },
  );
  return parsed.success ? parsed.data.sources : null;
}
