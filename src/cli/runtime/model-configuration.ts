/** Model preferences use the established configuration document and generation owner. */
import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import type { ConfigurationValue, ConfigurationValues } from "../../domain/configuration/index.ts";
import { storedModelPreferencesSchema } from "../../providers/configuration/policy-compatibility.ts";
import { readStoredModelPreferences } from "../../providers/configuration/policy-migration.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  type ModelPreferences,
} from "../../providers/configuration/policy-schema.ts";
export const MODEL_POLICY_CONFIGURATION_KEY = "models.policy";
/** JSON serialization removes optional undefined properties at this registry boundary. */
export function modelPreferencesValue(value: ModelPreferences): ConfigurationValue {
  return JSON.parse(JSON.stringify(value)) as ConfigurationValue;
}
export const MODEL_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: MODEL_POLICY_CONFIGURATION_KEY,
    summary: "Model role defaults, overrides, and explicit supporting-workload use policies.",
    objectSchema: storedModelPreferencesSchema,
    defaultValue: modelPreferencesValue(EMPTY_MODEL_PREFERENCES),
    scopes: ["user", "profile"],
    applicationClass: "next-operation",
    sensitivity: "public",
  }),
];
export function modelPreferencesFrom(values: ConfigurationValues): ModelPreferences {
  return readStoredModelPreferences(
    values[MODEL_POLICY_CONFIGURATION_KEY] ?? EMPTY_MODEL_PREFERENCES,
  );
}
