/**
 * Merge product tool catalogs and runners (#711 / #712).
 */

import type {
  CapabilityFamily,
  CapabilityRegistry,
  CapabilityRegistryEntry,
} from "../../domain/capabilities/index.ts";
import {
  type CapabilityId,
  type ConfigurationGeneration,
  configurationGeneration,
} from "../../domain/foundation/index.ts";
import type {
  ToolCatalog,
  ToolHookRegistry,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../../domain/tools/index.ts";
import { createToolHookRegistry, createToolRegistry } from "../../domain/tools/index.ts";
import { createProductCapabilityRegistry } from "../capabilities/product-capability-registry.ts";
import type { CapabilityTrustPort } from "../extensions/capability-trust.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "../runtime/tool-call-loop.ts";

export type ProductToolSourceBundle = {
  readonly hooks?: ToolHookRegistry;
  /** Host-validated native publication facts; package metadata cannot provide these ports. */
  readonly trust?: CapabilityTrustPort;
  readonly families?: ReadonlyMap<CapabilityId, CapabilityFamily>;
  readonly explicitOnly?: ReadonlySet<CapabilityId>;
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
  const trustOwners = new Map<string, CapabilityTrustPort>();
  const families = new Map<CapabilityId, CapabilityFamily>();
  const explicitOnly = new Set<CapabilityId>();
  for (const bundle of bundles) {
    for (const entry of bundle.registry.entries) {
      entries.push(entry);
      runners.set(entry.descriptor.name, bundle.runner);
      if (bundle.trust) trustOwners.set(entry.manifest.capabilityId, bundle.trust);
      const family = bundle.families?.get(entry.manifest.capabilityId);
      if (family) families.set(entry.manifest.capabilityId, family);
      if (bundle.explicitOnly?.has(entry.manifest.capabilityId))
        explicitOnly.add(entry.manifest.capabilityId);
    }
  }
  const registryResult = createToolRegistry(generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product tool merge failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;
  const hooks = createToolHookRegistry(
    configurationGeneration.from(
      Math.max(
        Number(generation),
        ...bundles.map((bundle) => Number(bundle.hooks?.generation ?? 0)),
      ),
    ),
    bundles.flatMap((bundle) => bundle.hooks?.hooks ?? []),
  );
  if (!hooks.ok) throw new Error(`product hook merge failed: ${hooks.error.code}`);
  const capabilityRegistry = createProductCapabilityRegistry(
    generation,
    registry,
    options.capabilityEntries,
    (id) => {
      const entry = registry.resolveByCapabilityId(id);
      return entry !== null && runners.get(entry.descriptor.name)?.hasBinding?.(id) === true;
    },
    { inspect: (id) => trustOwners.get(id)?.inspect(id) ?? null },
    families,
    explicitOnly,
  );
  const runner: ToolRunnerPort = {
    hasBinding(id) {
      const entry = registry.resolveByCapabilityId(id);
      return entry !== null && runners.get(entry.descriptor.name)?.hasBinding?.(id) === true;
    },
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
    ...(bundles.some((bundle) => bundle.hooks !== undefined) ? { hooks: hooks.value } : {}),
    registry,
    capabilityRegistry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
    trust: { inspect: (id) => trustOwners.get(id)?.inspect(id) ?? null },
    families,
    explicitOnly,
  };
}
