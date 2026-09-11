import type { HostPlatform } from "../../domain/tools/index.ts";

/** Unsupported host identities remain absent, so platform-constrained tools fail closed. */
export function productToolHost(): { toolHost?: HostPlatform } {
  const os = process.platform;
  const arch = process.arch;
  return (os === "darwin" || os === "linux" || os === "win32") &&
    (arch === "arm64" || arch === "x64")
    ? { toolHost: { os, arch } }
    : {};
}
