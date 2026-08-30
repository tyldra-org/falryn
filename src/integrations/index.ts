/**
 * The integrations layer's public entrypoint.
 *
 * Leaf adapters between Falryn ports and the host. Everything here may import
 * Bun and system APIs; nothing here may be imported by `src/domain`.
 */

export type {
  AnthropicSdkAdapterOptions,
  AnthropicSdkFetch,
  AnthropicSdkStreamFactory,
} from "./anthropic-sdk-adapter.ts";
export { createAnthropicSdkAdapter } from "./anthropic-sdk-adapter.ts";
export { classifySqliteError, openBunSqlite } from "./bun-sqlite.ts";
export type { CommandCodeProviderAdapterOptions } from "./command-code-provider-adapter.ts";
export { createCommandCodeProviderAdapter } from "./command-code-provider-adapter.ts";
export { createSha256Hasher } from "./content-digest.ts";
export { createEnvironmentCredentialStore } from "./environment-credentials.ts";
export type {
  GoogleGenAiSdkAdapterOptions,
  GoogleGenAiStreamFactory,
} from "./google-genai-sdk-adapter.ts";
export { createGoogleGenAiSdkAdapter } from "./google-genai-sdk-adapter.ts";
export type { HostBlobStore, HostBlobStoreOptions } from "./host-blobs.ts";
export { createHostBlobStore } from "./host-blobs.ts";
export type { HostCommandRunnerOptions } from "./host-commands.ts";
export { createHostCommandRunner } from "./host-commands.ts";
export {
  createHostFileChangeSubscriber,
  createManualFileChangeSubscriber,
  type HostFileChangeSubscriber,
} from "./host-configuration-watch.ts";
export { createHostEnvironment, hostHome, hostPlatform } from "./host-environment.ts";
export { createHostFileOutputStream, createHostFileSystem } from "./host-filesystem.ts";
export type { HostGitOptions } from "./host-git.ts";
export { createHostGitPort } from "./host-git.ts";
export {
  createOwnedProcessRegistry,
  OWNED_PROCESS_SHUTDOWN_PARTICIPANT,
  type OwnedProcessRegistry,
  type OwnedProcessRegistryBundle,
} from "./host-owned-process-registry.ts";
export type { HostPackageWriter, HostPackageWriterOptions } from "./host-packages.ts";
export { createHostPackageWriter, STAGED_SUFFIX } from "./host-packages.ts";
export type { HostProcessCaptureOptions } from "./host-process-capture.ts";
export { createHostProcessCapturePort } from "./host-process-capture.ts";
export type {
  HostManagedServicePortOptions,
  HostPtySessionPortOptions,
} from "./host-process-sessions.ts";
export { createHostManagedServicePort, createHostPtySessionPort } from "./host-process-sessions.ts";
export {
  escalateOwnedTree,
  ownedTreeSpawnOptions,
  processIsAlive,
  signalOwnedTree,
} from "./host-process-tree.ts";
export type { HostInputStreamOptions, HostOutputStreamOptions } from "./host-terminal.ts";
export {
  createHostInputStream,
  createHostOutputStream,
  observeHandles,
} from "./host-terminal.ts";
export type {
  KeychainCredentialStoreOptions,
  OperatingSystemSecretsPort,
} from "./keychain-credentials.ts";
export { createKeychainCredentialStore } from "./keychain-credentials.ts";
export type {
  CredentialWriteResult,
  WriteKeychainCredentialOptions,
} from "./keychain-write.ts";
export { writeKeychainCredential } from "./keychain-write.ts";
export type {
  OfficialModelDiscoveryLoaders,
  OfficialModelDiscoveryOptions,
} from "./official-model-discovery.ts";
export {
  createOfficialModelDiscovery,
  officialModelCapabilityTranslators,
} from "./official-model-discovery.ts";
export type { OpenAiSdkAdapterOptions, OpenAiSdkFetch } from "./openai-sdk-adapter.ts";
export { createOpenAiSdkAdapter } from "./openai-sdk-adapter.ts";
export { createProcessSignalPort, observedPlatformSignals } from "./process-signals.ts";
export type {
  SessionEnvironmentCredentialLookupOptions,
  SessionEnvironmentCredentialLookupPort,
  SessionEnvironmentLookupOutcome,
} from "./session-environment-credentials.ts";
export {
  createSessionEnvironmentCredentialLookup,
  LAUNCHCTL_EXECUTABLE,
} from "./session-environment-credentials.ts";
