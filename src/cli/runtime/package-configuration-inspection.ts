import { inspectGeneration } from "../../config/resolution/inspection.ts";
import { packageConfigurationPrefix } from "../../config/resolution/package-configuration.ts";
import { loadProductConfiguration } from "./product-configuration.ts";
import type { Services } from "./services.ts";

/** Uses the published product generation, including files and declared environment bridges. */
export async function inspectPackageConfiguration(
  services: Services,
  packageId: string,
  profile: string | null,
  signal: AbortSignal,
) {
  const loaded = await loadProductConfiguration(services, { profile, overrides: {} }, signal);
  const record = services.loader.current();
  const prefix = `${packageConfigurationPrefix(packageId)}.`;
  return {
    status: loaded.outcome.kind,
    generation: loaded.generation,
    values:
      record === null
        ? []
        : inspectGeneration(services.registry, record).values.filter((value) =>
            value.path.startsWith(prefix),
          ),
    diagnostics:
      loaded.outcome.kind === "rejected"
        ? loaded.outcome.issues
        : loaded.outcome.kind === "publish-failed"
          ? [{ code: loaded.outcome.code }]
          : [],
  };
}
