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

export type { ConfigurationKeyDeclaration } from "./document/declaration.ts";
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
} from "./document/declaration.ts";
export {
  assignConfigurationValue,
  createEmptyConfigurationDocument,
  parseConfigurationDocument,
  serializeConfigurationDocument,
} from "./document/document.ts";
export { MAX_CONFIGURATION_FILE_BYTES, parseJsonc, positionOf } from "./document/jsonc.ts";
export type { SchemaVersionPolicy, SchemaVersionVerdict } from "./document/schema-family.ts";
export {
  CONFIGURATION_MINIMUM_SCHEMA_VERSION,
  CONFIGURATION_SCHEMA_FAMILY,
  CONFIGURATION_SCHEMA_VERSION,
  DEFAULT_SCHEMA_VERSION_POLICY,
  evaluateSchemaVersion,
  MINIMUM_READER_FIELD,
  RESERVED_DOCUMENT_FIELDS,
  SCHEMA_VERSION_FIELD,
} from "./document/schema-family.ts";
export type {
  CredentialReferenceLookup,
  CredentialRemovalRequest,
} from "./host/credentials.ts";
export {
  createInMemoryReferenceStore,
  parseCredentialReference,
  readCredentialReference,
  removeCredential,
} from "./host/credentials.ts";
export type {
  ConfigurationHomeResolution,
  ConfigurationHomeRoots,
  ConfigurationHomeWriteResolution,
} from "./host/home.ts";
export {
  configurationHomeIssue,
  prepareConfigurationHomeForWrite,
  resolveConfigurationHome,
} from "./host/home.ts";
export type {
  ConfigurationReloadWatcher,
  ConfigurationReloadWatcherOptions,
  FileChangeSubscriber,
} from "./host/reload-watcher.ts";
export { createConfigurationReloadWatcher } from "./host/reload-watcher.ts";
export type {
  ConfigurationFileScope,
  ConfigurationValueWriteRequest,
  ConfigurationWriteOutcome,
  ConfigurationWriteRequest,
} from "./host/writer.ts";
export {
  configurationSourcePaths,
  resolveConfigurationFilePath,
  writeConfigurationKey,
  writeConfigurationValue,
} from "./host/writer.ts";
export type { BridgeResult } from "./resolution/bridges.ts";
export { readEnvironmentLayer, readOverrideLayer } from "./resolution/bridges.ts";
export type { Composition, CompositionInputs, LayerInput } from "./resolution/composition.ts";
export { composeLayers, declaredKeysOf } from "./resolution/composition.ts";
export {
  diffGenerations,
  nextGeneration,
  strongestApplicationClass,
} from "./resolution/generation.ts";
export { inspectGeneration } from "./resolution/inspection.ts";
export type { RetentionClass } from "./resolution/keys.ts";
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
} from "./resolution/keys.ts";
export type {
  ConfigurationLoader,
  ConfigurationLoaderOptions,
  LoadRequest,
} from "./resolution/loader.ts";
export { createConfigurationLoader } from "./resolution/loader.ts";
export { CONFIGURATION_OWNERSHIP } from "./resolution/ownership.ts";
export type {
  ConfigurationCrossFieldRule,
  ConfigurationRegistryOptions,
} from "./resolution/registry.ts";
export { createConfigurationRegistry, foldDeclaredValue } from "./resolution/registry.ts";
export type { DiscoveredSource, DiscoveryInputs, ReadSource } from "./resolution/sources.ts";
export {
  CONFIGURATION_FILE_NAME,
  discoverSources,
  isLegalProfileName,
  MAX_PROFILE_NAME_LENGTH,
  PROFILE_DIRECTORY,
  PROJECT_CONFIGURATION_DIRECTORY,
  readSource,
  sourceLabel,
} from "./resolution/sources.ts";
