/**
 * The host environment adapter.
 *
 * A leaf over `process.env`, and the reason `EnvironmentPort` exists: a test
 * that mutates `process.env` leaks into every test that runs after it, so root
 * resolution reads through this and tests supply a static map instead.
 *
 * It also resolves the host's home directory and platform, because both are
 * process facts of exactly the same kind and both are needed before any root
 * can be named.
 */

import { homedir } from "node:os";

import {
  type EnvironmentPort,
  type LocalDataPlatform,
  type LocalPath,
  parseLocalPath,
} from "../domain/index.ts";

export function createHostEnvironment(): EnvironmentPort {
  return {
    get(name: string): string | null {
      const value = process.env[name];
      // An exported-but-empty variable reads as unset. A shell produces that
      // for `export FALRYN_CACHE_DIR=`, and resolving a root to nothing is
      // worse than falling back to the platform default.
      return value === undefined || value === "" ? null : value;
    },
  };
}

/**
 * The running platform, narrowed onto the layouts this build declares.
 *
 * An unrecognized platform resolves to the Linux XDG layout rather than
 * failing: it is the closest convention for a Unix host, and the layout it
 * produces is marked unqualified either way.
 */
export function hostPlatform(): LocalDataPlatform {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      return "linux";
  }
}

/** The host's home directory, or `null` when it reports an unusable one. */
export function hostHome(): LocalPath | null {
  const parsed = parseLocalPath(homedir());
  return parsed.ok ? parsed.value : null;
}
