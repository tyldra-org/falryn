import { createRuntimeRedactor } from "../../application/diagnostics/redaction.ts";
import { V0_1_CROSS_FIELD_RULES } from "../../config/resolution/keys.ts";
import { createConfigurationLoader } from "../../config/resolution/loader.ts";
import { createConfigurationRegistry } from "../../config/resolution/registry.ts";
import { bytesDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import type { PackageDataDocument } from "../../domain/extensions/package-data-store.ts";
import { sessionId, streamId, traceId, workspaceId } from "../../domain/foundation/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { loadPackageConfiguration } from "./package-configuration.ts";
import { PRODUCT_CONFIGURATION_KEYS, type Services } from "./services.ts";

/** Stage installed declarations against complete normal sources before changing installed bytes. */
export async function validatePackageConfigurationCandidate(
  services: Services,
  candidate: PackageDataDocument,
  signal: AbortSignal,
): Promise<string> {
  const project = await services.workspaceTrust.project(signal);
  const request = {
    configurationRoot: services.configurationRoot,
    legacyConfigurationRoot: services.legacyConfigurationRoot,
    workspaceRoot: services.workspaceRoot,
    profile: null,
    projectText: project.text,
  };
  const packages = await loadPackageConfiguration(services, request, signal, new Map(), candidate);
  const declarations = [...PRODUCT_CONFIGURATION_KEYS, ...packages.declarations];
  const registry = createConfigurationRegistry({
    declarations,
    crossFieldRules: V0_1_CROSS_FIELD_RULES,
    redactor: createRuntimeRedactor(),
  });
  const loader = createConfigurationLoader({
    registry,
    declarations,
    fileSystem: services.fileSystem,
    environment: services.environment,
    clock: services.clock,
    redactor: createRuntimeRedactor(),
    eventStore: createInMemoryEventStore(),
    streamId: streamId.from("package-configuration-validation"),
    correlation: {
      sessionId: sessionId.from("package-validation"),
      workspaceId: workspaceId.from("package-validation"),
      traceId: traceId.from("package-validation"),
    },
    prepare: async () => ({ ...packages, registry, declarations, publish: () => {} }),
  });
  const result = await loader.load(request, signal);
  if (result.kind !== "published" && result.kind !== "unchanged")
    throw new ExtensionInputError("invalid-candidate-configuration");
  return bytesDigest(
    JSON.stringify({
      values: result.record.values,
      sources: result.record.sources,
      packageGeneration: packages.generation,
    }),
  );
}
