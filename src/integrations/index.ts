/**
 * The integrations layer's public entrypoint.
 *
 * Leaf adapters between Falryn ports and the host. Everything here may import
 * Bun and system APIs; nothing here may be imported by `src/domain`.
 */

export { classifySqliteError, openBunSqlite } from "./bun-sqlite.ts";
export { createEnvironmentCredentialStore } from "./environment-credentials.ts";
export { createHostCommandRunner } from "./host-commands.ts";
export { createHostEnvironment, hostHome, hostPlatform } from "./host-environment.ts";
export { createHostFileSystem } from "./host-filesystem.ts";
export type { KeychainCredentialStoreOptions } from "./keychain-credentials.ts";
export {
  createKeychainCredentialStore,
  KEYCHAIN_EXIT_STATUSES,
  SECURITY_EXECUTABLE,
} from "./keychain-credentials.ts";
export { createProcessSignalPort, observedPlatformSignals } from "./process-signals.ts";
