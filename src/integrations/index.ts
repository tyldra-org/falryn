/**
 * The integrations layer's public entrypoint.
 *
 * Leaf adapters between Falryn ports and the host. Everything here may import
 * Bun and system APIs; nothing here may be imported by `src/domain`.
 */

export { createHostEnvironment, hostHome, hostPlatform } from "./host-environment.ts";
export { createHostFileSystem } from "./host-filesystem.ts";
export { createProcessSignalPort, observedPlatformSignals } from "./process-signals.ts";
