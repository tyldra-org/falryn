import { join } from "node:path";
import { createPackageHealth } from "../../application/extensions/package-health.ts";
import type { ProductTaskResources } from "../../application/orchestration/product-resources.ts";
import type { CatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { rootChild } from "../../data/index.ts";
import { isUnreadSource } from "../../domain/configuration/index.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { PackageRequest } from "../../domain/extensions/lifecycle.ts";
import type { PackageHealthStore } from "../../domain/extensions/package-health.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { createHostPackageHealth } from "../../integrations/extensions/host-package-health.ts";
import { FALRYN_VERSION } from "../version.ts";
import { composeExtensionCatalog } from "./extension-catalog.ts";
import { SANDBOX_CONFIGURATION_KEY, sandboxConfigurationSchema } from "./sandbox-configuration.ts";
import type { Services } from "./services.ts";

export async function runPackageHealth(
  services: Services,
  records: { catalog: CatalogRepositories; health: PackageHealthStore },
  resources: ProductTaskResources,
  request: PackageRequest,
  signal: AbortSignal,
) {
  const root = rootChild(services.localData.layout, "state");
  if (root === null) throw new ExtensionInputError("health-root-unavailable");
  const catalog = composeExtensionCatalog({ services, records: records.catalog });
  const policy = () => {
    const current = services.loader.current();
    const configuration = sandboxConfigurationSchema.safeParse(
      current?.values[SANDBOX_CONFIGURATION_KEY],
    );
    return {
      mode:
        current !== null && !current.sources.some(isUnreadSource) && configuration.success
          ? configuration.data.mode
          : "unavailable",
      generation: Number(current?.generation ?? 0),
    };
  };
  return createPackageHealth({
    packages: records.catalog.packages,
    bytes: createHostPackageCache(join(root, "packages")),
    store: records.health,
    host: { falryn: FALRYN_VERSION, bun: Bun.version, os: process.platform, arch: process.arch },
    execution: createHostPackageHealth({ directory: join(root, "package-health"), policy }),
    resources,
    async authority(installed, contribution, signal) {
      if (signal.aborted) throw new ExtensionInputError("cancelled");
      await services.loader.load({
        configurationRoot: services.configurationRoot,
        legacyConfigurationRoot: services.legacyConfigurationRoot,
        workspaceRoot: null,
        profile: null,
        overrides: {},
      });
      const authority = await catalog.healthAuthority(installed, contribution, signal);
      const selected = policy();
      return {
        ...authority,
        strict: selected.mode === "strict",
        inputs: canonicalDigest({
          authority: authority.inputs,
          policy: selected,
          configuration: services.loader.current()?.values ?? {},
        }),
      };
    },
  }).run(request, signal);
}
