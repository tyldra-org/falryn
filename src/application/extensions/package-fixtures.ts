import { bytesDigest } from "../../domain/extensions/canonical.ts";
import {
  FALRYN_EXTENSION_NAMESPACE,
  PORTABLE_PLUGIN_SCHEMA,
} from "../../domain/extensions/manifest.ts";
import type { PackageSource } from "../../domain/extensions/package-source.ts";

export const inspectionHost = { falryn: "0.0.0", bun: "1.4.1", os: "darwin", arch: "arm64" };
export const declaredAuthority = {
  effects: [],
  permissions: [],
  roots: [],
  destinations: [],
  secretReferences: [],
  localData: [],
};
export const executionResources = {
  startupMs: 1_000,
  requestMs: 5_000,
  shutdownMs: 1_000,
  maxOutputBytes: 1_024,
  maxConcurrent: 1,
};
export const executableDeclaration = {
  mode: "full-user",
  executable: "scripts/run.ts",
  loader: "bun",
  protocolVersion: "1",
  compatibility: {},
  resources: executionResources,
};
export function pluginManifest(
  extension: unknown = { version: 1 },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    $schema: PORTABLE_PLUGIN_SCHEMA,
    name: "fixture",
    version: "1.0.0",
    extensions: { [FALRYN_EXTENSION_NAMESPACE]: extension },
    ...extra,
  };
}
export function packageSource(
  manifest: unknown = pluginManifest(),
  files: Record<string, string> = {},
): PackageSource {
  const sourceFiles = { "plugin.json": JSON.stringify(manifest), ...files };
  return {
    async read() {
      return {
        sourceId: bytesDigest("fixture-root"),
        files: Object.entries(sourceFiles).map(([path, text]) => ({
          path,
          bytes: new TextEncoder().encode(text),
        })),
        diagnostics: [],
        omittedDiagnostics: 0,
      };
    },
  };
}
