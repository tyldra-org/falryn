/**
 * Stable host process-session facade.
 *
 * Interactive PTYs and managed pipe services remain separate adapters while
 * sharing only Bun subprocess lifecycle primitives.
 */

export {
  createHostManagedServicePort,
  type HostManagedServicePortOptions,
} from "./host-process-sessions/managed-service.ts";
export {
  createHostPtySessionPort,
  type HostPtySessionPortOptions,
} from "./host-process-sessions/pty.ts";
