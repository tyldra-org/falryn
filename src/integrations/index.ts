/**
 * The integrations layer's public entrypoint.
 *
 * Leaf adapters between Falryn ports and the host. Everything here may import
 * Bun and system APIs; nothing here may be imported by `src/domain`.
 */

export { createProcessSignalPort, observedPlatformSignals } from "./process-signals.ts";
