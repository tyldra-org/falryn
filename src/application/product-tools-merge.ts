/**
 * Merge product tool catalogs and runners (#711 / #712).
 */

import type {
  ConfigurationGeneration,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../domain/index.ts";
import { createToolRegistry } from "../domain/index.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";

export type ProductToolBundle = {
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
};

/**
 * Combine registry entries and dispatch by tool name across runners.
 */
export function mergeProductToolBundles(
  generation: ConfigurationGeneration,
  bundles: readonly ProductToolBundle[],
): ProductToolBundle {
  const entries: ToolRegistryEntry[] = [];
  const runners = new Map<string, ToolRunnerPort>();
  for (const bundle of bundles) {
    for (const entry of bundle.registry.entries) {
      entries.push(entry);
      runners.set(entry.descriptor.name, bundle.runner);
    }
  }
  const registryResult = createToolRegistry(generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product tool merge failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;
  const runner: ToolRunnerPort = {
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      const owned = runners.get(request.toolName);
      if (owned === undefined) {
        return {
          status: "unavailable",
          reason: `unknown product tool: ${request.toolName}`,
          effect: "none",
        };
      }
      return owned.execute(request);
    },
  };
  return {
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
  };
}
