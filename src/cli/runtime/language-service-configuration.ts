import {
  EMPTY_LANGUAGE_SERVICES,
  LANGUAGE_SERVICES_KEY,
  languageServicesSchema,
} from "../../application/tools/product-language-tools/configuration.ts";
import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import {
  type ConfigurationGenerationRecord,
  type ConfigurationValues,
  isUnreadSource,
} from "../../domain/configuration/index.ts";

export const LANGUAGE_SERVICE_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: LANGUAGE_SERVICES_KEY,
    summary:
      "User-authorized language servers, debug adapters, and exact launch or attach targets.",
    objectSchema: languageServicesSchema,
    defaultValue: { languageServers: [], debugAdapters: [] },
    scopes: ["user"],
    applicationClass: "next-operation",
    sensitivity: "sensitive",
  }),
];

export function languageServiceConfiguration(
  values: ConfigurationValues,
  generation: number,
  record?: ConfigurationGenerationRecord | null,
) {
  if (record === null || record?.sources.some(isUnreadSource))
    throw new Error("language-service-configuration-unavailable");
  return {
    generation,
    services: languageServicesSchema.parse(
      values[LANGUAGE_SERVICES_KEY] ?? EMPTY_LANGUAGE_SERVICES,
    ),
  };
}
