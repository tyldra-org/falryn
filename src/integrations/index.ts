/**
 * The integrations layer's public entrypoint.
 *
 * Leaf adapters between Falryn ports and the host. Everything here may import
 * Bun and system APIs; nothing here may be imported by `src/domain`.
 */

export type { HostAuthorizedProviderLoginOptions } from "./authentication/authorized-login-host.ts";
export {
  createAuthorizationCrypto,
  createBunAuthorizationLoopback,
  createHostAuthorizedProviderLogin,
} from "./authentication/authorized-login-host.ts";
export { createEnvironmentCredentialStore } from "./authentication/environment-credentials.ts";
export type {
  KeychainCredentialStoreOptions,
  OperatingSystemSecretsPort,
} from "./authentication/keychain-credentials.ts";
export { createKeychainCredentialStore } from "./authentication/keychain-credentials.ts";
export type {
  CredentialWriteResult,
  WriteKeychainCredentialOptions,
} from "./authentication/keychain-write.ts";
export { writeKeychainCredential } from "./authentication/keychain-write.ts";
export { createOpenAiCodexAuthorizedLoginAdapter } from "./authentication/openai-codex-authorized-login-adapter.ts";
export type {
  SessionEnvironmentCredentialLookupOptions,
  SessionEnvironmentCredentialLookupPort,
  SessionEnvironmentLookupOutcome,
} from "./authentication/session-environment-credentials.ts";
export {
  createSessionEnvironmentCredentialLookup,
  LAUNCHCTL_EXECUTABLE,
} from "./authentication/session-environment-credentials.ts";
export {
  createHostFileChangeSubscriber,
  createManualFileChangeSubscriber,
  type HostFileChangeSubscriber,
} from "./configuration/host-configuration-watch.ts";
export { createHostEnvironment, hostHome, hostPlatform } from "./configuration/host-environment.ts";
export type { HostPackageWriter, HostPackageWriterOptions } from "./extensions/host-packages.ts";
export { createHostPackageWriter, STAGED_SUFFIX } from "./extensions/host-packages.ts";
export { createSha256Hasher } from "./filesystem/content-digest.ts";
export type { HostBlobStore, HostBlobStoreOptions } from "./filesystem/host-blobs.ts";
export { createHostBlobStore } from "./filesystem/host-blobs.ts";
export { createHostFileOutputStream, createHostFileSystem } from "./filesystem/host-filesystem.ts";
export type { HostGitOptions } from "./git/host-git.ts";
export { createHostGitPort } from "./git/host-git.ts";
export type { HostCommandRunnerOptions } from "./process/host-commands.ts";
export { createHostCommandRunner } from "./process/host-commands.ts";
export {
  createOwnedProcessRegistry,
  OWNED_PROCESS_SHUTDOWN_PARTICIPANT,
  type OwnedProcessRegistry,
  type OwnedProcessRegistryBundle,
} from "./process/host-owned-process-registry.ts";
export type { HostProcessCaptureOptions } from "./process/host-process-capture.ts";
export { createHostProcessCapturePort } from "./process/host-process-capture.ts";
export type {
  HostManagedServicePortOptions,
  HostPtySessionPortOptions,
} from "./process/host-process-sessions.ts";
export {
  createHostManagedServicePort,
  createHostPtySessionPort,
} from "./process/host-process-sessions.ts";
export {
  escalateOwnedTree,
  ownedTreeSpawnOptions,
  processIsAlive,
  signalOwnedTree,
} from "./process/host-process-tree.ts";
export { createProcessSignalPort, observedPlatformSignals } from "./process/process-signals.ts";
export type {
  AnthropicSdkAdapterOptions,
  AnthropicSdkFetch,
  AnthropicSdkStreamFactory,
} from "./providers/anthropic-sdk-adapter.ts";
export { createAnthropicSdkAdapter } from "./providers/anthropic-sdk-adapter.ts";
export type { CommandCodeProviderAdapterOptions } from "./providers/command-code-provider-adapter.ts";
export { createCommandCodeProviderAdapter } from "./providers/command-code-provider-adapter.ts";
export type {
  GoogleCachedContentBinding,
  GoogleCachedContentBindingPort,
  GoogleGenAiSdkAdapterOptions,
  GoogleGenAiStreamFactory,
} from "./providers/google-genai-sdk-adapter.ts";
export { createGoogleGenAiSdkAdapter } from "./providers/google-genai-sdk-adapter.ts";
export type {
  OfficialModelDiscoveryLoaders,
  OfficialModelDiscoveryOptions,
} from "./providers/official-model-discovery.ts";
export {
  createOfficialModelDiscovery,
  officialModelCapabilityTranslators,
} from "./providers/official-model-discovery.ts";
export type { OpenAiProviderAdapterOptions } from "./providers/openai-provider-adapter.ts";
export { createOpenAiProviderAdapter } from "./providers/openai-provider-adapter.ts";
export type {
  OpenAiResponsesSdkAdapterOptions,
  OpenAiResponsesSdkFetch,
} from "./providers/openai-responses-sdk-adapter.ts";
export { createOpenAiResponsesSdkAdapter } from "./providers/openai-responses-sdk-adapter.ts";
export type { OpenAiSdkAdapterOptions, OpenAiSdkFetch } from "./providers/openai-sdk-adapter.ts";
export { createOpenAiSdkAdapter } from "./providers/openai-sdk-adapter.ts";
export { classifySqliteError, openBunSqlite } from "./storage/bun-sqlite.ts";
export type { HostInputStreamOptions, HostOutputStreamOptions } from "./terminal/host-terminal.ts";
export {
  createHostInputStream,
  createHostOutputStream,
  observeHandles,
} from "./terminal/host-terminal.ts";
