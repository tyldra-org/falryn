/**
 * Merge product tool catalogs and runners (#711 / #712).
 */

import type {
  CapabilityRegistry,
  CapabilityRegistryEntry,
  ConfigurationGeneration,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../domain/index.ts";
import { createToolRegistry } from "../domain/index.ts";
import { createProductCapabilityRegistry } from "./product-capability-registry.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";

export type ProductToolSourceBundle = {
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
};

export type ProductToolBundle = ProductToolSourceBundle & {
  readonly capabilityRegistry: CapabilityRegistry;
};

export type ProductToolMergeOptions = {
  /** Validated non-tool contributions from skills, MCP, plugins, and other owners. */
  readonly capabilityEntries?: readonly CapabilityRegistryEntry[];
  /** Publish workspace state after any tool reports an observed mutation. */
  readonly afterMutation?: (
    request: ToolRunnerRequest,
    outcome: Extract<ToolInvocationOutcome, { readonly status: "completed" }>,
  ) => Promise<boolean | Readonly<Record<string, unknown>>>;
};

/**
 * Combine registry entries and dispatch by tool name across runners.
 */
export function mergeProductToolBundles(
  generation: ConfigurationGeneration,
  bundles: readonly ProductToolSourceBundle[],
  options: ProductToolMergeOptions = {},
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
  const capabilityRegistry = createProductCapabilityRegistry(
    generation,
    registry,
    options.capabilityEntries,
  );
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
      const outcome = await owned.execute(request);
      if (request.effect === "observation" || outcome.effect === "none") {
        return outcome;
      }
      if (outcome.status !== "completed") {
        return outcome;
      }
      const feedback = await options.afterMutation?.(request, outcome);
      if (feedback === undefined || feedback === true) return outcome;
      if (feedback === false) {
        return {
          ...outcome,
          output: {
            ...outcome.output,
            workspaceIndex: { status: "unavailable", code: "refresh-failed" },
          },
        };
      }
      return { ...outcome, output: { ...outcome.output, ...feedback } };
    },
  };
  return {
    registry,
    capabilityRegistry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
  };
}
