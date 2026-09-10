import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPackageDataImportRepository } from "../../data/extensions/package-data-import-repository.ts";
import { createPackageDataRepository } from "../../data/extensions/package-data-repository.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import { openProductStoreOrThrow, temporaryRoot } from "../../data/fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import type { PackageAction, PackageRequest } from "../../domain/extensions/lifecycle.ts";
import {
  packageConfigurationDeclarationSchema,
  packageStateDeclarationSchema,
} from "../../domain/extensions/package-data.ts";
import type { PackageDataStore } from "../../domain/extensions/package-data-store.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { createPackageDataService } from "./package-data.ts";
import { inspectionHost, packageSource, pluginManifest } from "./package-fixtures.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";

export const setting = packageConfigurationDeclarationSchema.parse({
  version: 1,
  id: "display.label",
  schemaVersion: 1,
  schema: { type: "string", maxLength: 32 },
  default: "default",
  scopes: ["user", "project", "profile", "environment", "cli"],
  sensitivity: "public",
  merge: { kind: "replace" },
  application: "next-turn",
  compatibility: "*",
});
export const stateFamily = packageStateDeclarationSchema.parse({
  version: 1,
  id: "preferences",
  schemaVersion: 1,
  schema: {
    type: "object",
    properties: { color: { type: "string", maxLength: 32 } },
    required: ["color"],
    additionalProperties: false,
  },
  scopes: ["user", "workspace", "session", "process", "development"],
  sensitivity: "public",
  retention: "until-uninstall",
  cleanup: "confirm",
  maxBytes: 1024,
  maxRecords: 32,
  fork: "copy",
  export: "inert",
});
export const dataManifest = (version = "1.0.0", family = stateFamily) =>
  pluginManifest({ version: 1, configuration: [setting], state: [family] }, { version });
export async function packageDataFixture() {
  const root = await temporaryRoot("falryn-package-data-");
  const store = await openProductStoreOrThrow(root);
  const packages = createPackageLifecycleRepository(store);
  const lifecycle = createPackageLifecycle(
    packages,
    createHostPackageCache(join(root, "packages")),
    inspectionHost,
  );
  const signal = new AbortController().signal;
  async function apply(action: PackageAction, request: PackageRequest, manifest?: unknown) {
    const source = manifest === undefined ? undefined : packageSource(manifest);
    const preview = await lifecycle.run(action, request, signal, source);
    if (preview.status !== "preview" || !preview.confirmation)
      throw new Error(JSON.stringify(preview));
    return lifecycle.run(
      action,
      { ...request, confirmation: preview.confirmation },
      signal,
      source,
    );
  }
  const request = (revision: number, extra: Partial<PackageRequest> = {}): PackageRequest => ({
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: revision,
    retention: "retain",
    ...extra,
  });
  const installed = await apply("install", request(0), dataManifest());
  if (installed.status !== "completed") throw new Error(JSON.stringify(installed));
  const data = createPackageDataRepository(store);
  const imports = createPackageDataImportRepository(store);
  let admitted = true;
  const service = (stateStore: PackageDataStore = data) => {
    const current = packages.current("fixture");
    if (!current.ok || !current.value.current) throw new Error("missing package");
    const selected = current.value;
    const version = selected.current;
    if (!version) throw new Error("missing version");
    const binding = {
      version: 1 as const,
      packageId: "fixture",
      packageDigest: version.identityDigest,
      packageVersion: version.identity.packageVersion ?? "1.0.0",
      contribution: null,
      packageRevision: selected.revision,
      configurationGeneration: 1,
      catalogGeneration: version.identityDigest,
      workspaceGeneration: "workspace-1",
      sessionGeneration: "session-1",
      protocolGeneration: "1",
      authority: canonicalDigest("test-authority"),
    };
    return createPackageDataService({
      store: stateStore,
      imports,
      authority: {
        binding,
        hostControl: true,
        principal: "test-user",
        current: () => admitted,
        allows: (_scope, owner) => owner === "test-user" || owner.startsWith("session-"),
      },
      now: () => 1000,
    });
  };
  const identity = {
    version: 1 as const,
    packageId: "fixture",
    contribution: null,
    family: "preferences",
    key: "view",
    scope: "user" as const,
    owner: "test-user",
  };
  return {
    root,
    store,
    packages,
    lifecycle,
    data,
    imports,
    service,
    identity,
    apply,
    request,
    revoke: () => {
      admitted = false;
    },
  };
}
