/**
 * The integrations layer's public entrypoint.
 *
 * Leaf adapters between Falryn ports and the host. Everything here may import
 * Bun and system APIs; nothing here may be imported by `src/domain`.
 */

export { classifySqliteError, openBunSqlite } from "./bun-sqlite.ts";
export { createSha256Hasher } from "./content-digest.ts";
export { createEnvironmentCredentialStore } from "./environment-credentials.ts";
export type { HostBlobStoreOptions } from "./host-blobs.ts";
export { createHostBlobStore } from "./host-blobs.ts";
export { createHostCommandRunner } from "./host-commands.ts";
export { createHostEnvironment, hostHome, hostPlatform } from "./host-environment.ts";
export { createHostFileOutputStream, createHostFileSystem } from "./host-filesystem.ts";
export type { HostGitOptions } from "./host-git.ts";
export { createHostGitPort } from "./host-git.ts";
export type { HostPackageWriterOptions } from "./host-packages.ts";
export { createHostPackageWriter, STAGED_SUFFIX } from "./host-packages.ts";
export type { HostProcessCaptureOptions } from "./host-process-capture.ts";
export { createHostProcessCapturePort } from "./host-process-capture.ts";
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
export type { KeychainCredentialStoreOptions } from "./keychain-credentials.ts";
export {
  createKeychainCredentialStore,
  KEYCHAIN_EXIT_STATUSES,
  SECURITY_EXECUTABLE,
} from "./keychain-credentials.ts";
export type {
  CredentialWriteResult,
  WriteKeychainCredentialOptions,
} from "./keychain-write.ts";
export { writeKeychainCredential } from "./keychain-write.ts";
export { createProcessSignalPort, observedPlatformSignals } from "./process-signals.ts";
