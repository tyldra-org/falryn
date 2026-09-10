import { userInfo } from "node:os";
import {
  validatePackageSetting,
  validatePackageSettings,
} from "../../application/extensions/package-data-policy.ts";
import type { ConfigurationKeyDeclaration } from "../../config/document/declaration.ts";
import type { LayerInput } from "../../config/resolution/composition.ts";
import type { LoadRequest } from "../../config/resolution/loader.ts";
import {
  packageConfigurationKeys,
  packageConfigurationPrefix,
} from "../../config/resolution/package-configuration.ts";
import { listPackageData } from "../../data/extensions/package-data-inventory.ts";
import { rootChild, sqliteDatabasePath } from "../../data/index.ts";
import type { ConfigurationIssue } from "../../domain/configuration/index.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { catalogWorkspaceBinding } from "../../domain/extensions/catalog-history.ts";
import type { PackageDataDocument } from "../../domain/extensions/package-data-store.ts";
import { isCleanClose } from "../../domain/storage/index.ts";
import { openSessionStore } from "../commands/storage.ts";
import type { Services } from "./services.ts";

/** Reads installed declarations through the existing database boundary. Nothing is installed or enabled. */
export async function loadPackageConfiguration(
  services: Services,
  request: LoadRequest,
  signal?: AbortSignal,
  previous: ReadonlyMap<string, PackageDataDocument> = new Map(),
  candidate?: PackageDataDocument,
) {
  const declarations: ConfigurationKeyDeclaration[] = [];
  const layers: LayerInput[] = [];
  const bindings: { packageId: string; digest: string; revision: number }[] = [];
  const issues: ConfigurationIssue[] = [];
  const documents = new Map<string, PackageDataDocument>();
  const root = rootChild(services.localData.layout, "state");
  const path = root === null ? null : sqliteDatabasePath(root);
  if (path === null) throw new ExtensionInputError("package-configuration-root-unavailable");
  const file = await services.fileSystem.stat(path, signal);
  if (!file.ok) throw new ExtensionInputError("package-configuration-store-unavailable");
  const packages: PackageDataDocument[] = [];
  if (file.value !== null) {
    const opened = await openSessionStore(() => services, signal);
    if (!opened.ok) throw new ExtensionInputError("package-configuration-store-unavailable");
    if (opened.kind === "open") {
      let closed = false;
      try {
        const retained: PackageDataDocument[] = [];
        packages.push(
          ...listPackageData(opened.store, true, 256, (packageId, digest) => {
            const old = previous.get(packageId);
            const usable = old?.packageDigest === digest;
            if (usable && old) retained.push(old);
            issues.push({
              kind: "package-unavailable",
              severity: "warning",
              path: packageConfigurationPrefix(packageId),
              retained: usable,
            });
          }),
          ...retained,
        );
      } finally {
        closed = isCleanClose(await opened.store.close());
      }
      if (!closed) throw new ExtensionInputError("package-configuration-store-close-failed");
    }
  }
  if (candidate) {
    const index = packages.findIndex((document) => document.packageId === candidate.packageId);
    if (index < 0) packages.push(candidate);
    else packages[index] = candidate;
  }
  const user = userInfo();
  const actor = canonicalDigest({ kind: "local-user", uid: user.uid, username: user.username });
  const workspace = await services.ensureWorkspaceSet(signal);
  const trust = await services.workspaceTrust.resolve(undefined, signal);
  const roots = workspace.ok ? catalogWorkspaceBinding(workspace.value.set) : null;
  const admitted = trust.status === "accepted" || trust.status === "empty";
  const kinds = {
    user: "user-file",
    project: "project-file",
    profile: "profile",
    environment: "environment",
    cli: "cli-override",
  } as const;
  for (const document of packages) {
    if (signal?.aborted) throw new ExtensionInputError("cancelled");
    validatePackageSettings(document);
    documents.set(document.packageId, document);
    const prefix = packageConfigurationPrefix(document.packageId);
    declarations.push(
      ...packageConfigurationKeys({
        packageId: document.packageId,
        declarations: document.declarations.configuration,
        allowedScopes: ["user", "project", "profile", "environment", "cli"],
        validateSensitive: validatePackageSetting,
      }),
    );
    bindings.push({
      packageId: document.packageId,
      digest: document.packageDigest,
      revision: document.configurationRevision,
    });
    for (const layer of document.layers) {
      const allowed =
        layer.scope === "user"
          ? layer.owner === actor
          : layer.scope === "project"
            ? admitted && layer.owner === roots
            : layer.scope === "profile" && layer.owner === request.profile;
      if (!allowed) continue;
      layers.push({
        scope: layer.scope,
        source: {
          kind: kinds[layer.scope],
          file: null,
          profile: layer.scope === "profile" ? layer.owner : null,
        },
        values: Object.fromEntries(
          Object.entries(layer.values).map(([key, value]) => [`${prefix}.${key}`, value]),
        ),
      });
    }
  }
  return {
    declarations,
    layers,
    issues,
    documents,
    generation: canonicalDigest({ bindings, issues }),
  };
}
