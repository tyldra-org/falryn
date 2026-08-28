/**
 * The configuration area's public entrypoint.
 *
 * This area owns the `falryn.configuration` schema family: what a key is, what
 * it defaults to, how a value is validated, how its version evolves, and how it
 * may be displayed. It depends on `src/domain` and Zod, and on nothing further
 * out — it reaches no filesystem, no environment, and no credential store.
 *
 * Redaction is injected as a `SensitiveValueRedactor` rather than imported,
 * because the runtime's redactor lives in the application layer. Composition
 * supplies it; this area writes no redaction rules of its own.
 */

export type { BridgeResult } from "./bridges.ts";
export { readEnvironmentLayer, readOverrideLayer } from "./bridges.ts";
export type { Composition, CompositionInputs, LayerInput } from "./composition.ts";
export { composeLayers, declaredKeysOf } from "./composition.ts";
export type {
  CredentialReferenceLookup,
  CredentialRemovalRequest,
} from "./credentials.ts";
export {
  createInMemoryReferenceStore,
  parseCredentialReference,
  readCredentialReference,
  removeCredential,
} from "./credentials.ts";
export type { ConfigurationKeyDeclaration } from "./declaration.ts";
export {
  credentialReferenceKey,
  enumKey,
  identifiedArrayKey,
  integerKey,
  limitKey,
  limitSchema,
  mapKey,
  mapZodIssues,
  objectKey,
  pathOverrideKey,
} from "./declaration.ts";
export {
  assignConfigurationValue,
  createEmptyConfigurationDocument,
  parseConfigurationDocument,
  serializeConfigurationDocument,
} from "./document.ts";
export {
  diffGenerations,
  nextGeneration,
  strongestApplicationClass,
} from "./generation.ts";
export type {
  ConfigurationHomeResolution,
  ConfigurationHomeRoots,
  ConfigurationHomeWriteResolution,
} from "./home.ts";
export {
  configurationHomeIssue,
  prepareConfigurationHomeForWrite,
  resolveConfigurationHome,
} from "./home.ts";
export { inspectGeneration } from "./inspection.ts";
export { MAX_CONFIGURATION_FILE_BYTES, parseJsonc, positionOf } from "./jsonc.ts";
export type { RetentionClass } from "./keys.ts";
export {
  DATA_KEYS,
  DIAGNOSTICS_KEYS,
  MAX_CLASS_BYTES,
  MAX_RETENTION_MS,
  MAX_ROOT_PATH_LENGTH,
  MIN_CLASS_BYTES,
  MIN_RETENTION_MS,
  RETENTION_CLASSES,
  TOTAL_QUOTA_COVERS_CLASSES,
  V0_1_CONFIGURATION_KEYS,
  V0_1_CROSS_FIELD_RULES,
} from "./keys.ts";
export type {
  ConfigurationLoader,
  ConfigurationLoaderOptions,
  LoadRequest,
} from "./loader.ts";
export { createConfigurationLoader } from "./loader.ts";
export { CONFIGURATION_OWNERSHIP } from "./ownership.ts";
export type {
  ConfigurationCrossFieldRule,
  ConfigurationRegistryOptions,
} from "./registry.ts";
export { createConfigurationRegistry, foldDeclaredValue } from "./registry.ts";
export type {
  ConfigurationReloadWatcher,
  ConfigurationReloadWatcherOptions,
  FileChangeSubscriber,
} from "./reload-watcher.ts";
export { createConfigurationReloadWatcher } from "./reload-watcher.ts";
export type { SchemaVersionPolicy, SchemaVersionVerdict } from "./schema-family.ts";
export {
  CONFIGURATION_MINIMUM_SCHEMA_VERSION,
  CONFIGURATION_SCHEMA_FAMILY,
  CONFIGURATION_SCHEMA_VERSION,
  DEFAULT_SCHEMA_VERSION_POLICY,
  evaluateSchemaVersion,
  MINIMUM_READER_FIELD,
  RESERVED_DOCUMENT_FIELDS,
  SCHEMA_VERSION_FIELD,
} from "./schema-family.ts";
export type { DiscoveredSource, DiscoveryInputs, ReadSource } from "./sources.ts";
export {
  CONFIGURATION_FILE_NAME,
  discoverSources,
  isLegalProfileName,
  MAX_PROFILE_NAME_LENGTH,
  PROFILE_DIRECTORY,
  PROJECT_CONFIGURATION_DIRECTORY,
  readSource,
  sourceLabel,
} from "./sources.ts";
export type {
  ConfigurationFileScope,
  ConfigurationValueWriteRequest,
  ConfigurationWriteOutcome,
  ConfigurationWriteRequest,
} from "./writer.ts";
export {
  configurationSourcePaths,
  resolveConfigurationFilePath,
  writeConfigurationKey,
  writeConfigurationValue,
} from "./writer.ts";
