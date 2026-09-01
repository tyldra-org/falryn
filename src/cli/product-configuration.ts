/**
 * Configuration load for long-lived product runs (#728).
 *
 * Product bootstrap observes configuration generations through the loader and
 * event store rather than hardcoding generation zero. The same load request
 * shape and outcome vocabulary as `resolveShellConfiguration` and the `config`
 * commands.
 */

import type { ConfigurationLoader } from "../config/index.ts";
import {
  assertNever,
  type ConfigurationGeneration,
  type ConfigurationLoadOutcome,
  type ConfigurationRegistryPort,
  type ConfigurationValues,
  FIRST_CONFIGURATION_GENERATION,
} from "../domain/index.ts";
import { configurationOverridesFor, type GlobalOptions } from "./options.ts";
import type { Services } from "./services.ts";

export type ProductConfigurationLoadRequest = {
  readonly profile: string | null;
  readonly overrides: Readonly<Record<string, string>>;
};

/** Profile and CLI overrides for one invocation, shared with the shell path. */
export function productConfigurationLoadRequest(
  globals: GlobalOptions,
): ProductConfigurationLoadRequest {
  return {
    profile: globals.profile,
    overrides: configurationOverridesFor(globals),
  };
}

/**
 * Generation a product graph should correlate on after a loader outcome.
 *
 * Published and unchanged carry the record's generation. Rejected and
 * publish-failed retain the previous generation when one exists. On a first
 * load with nothing retained, or when loading was cancelled before a record
 * existed, falls back to the first generation constant — the same identity the
 * runtime uses when no loader has run yet.
 */
export function configurationGenerationFromLoadOutcome(
  outcome: ConfigurationLoadOutcome,
  loader: ConfigurationLoader,
): ConfigurationGeneration {
  switch (outcome.kind) {
    case "published":
    case "unchanged":
      return outcome.record.generation;
    case "rejected":
      return outcome.retained?.generation ?? FIRST_CONFIGURATION_GENERATION;
    case "publish-failed":
      return outcome.retained?.generation ?? FIRST_CONFIGURATION_GENERATION;
    case "cancelled":
      return loader.current()?.generation ?? FIRST_CONFIGURATION_GENERATION;
    default:
      return assertNever(outcome, "unhandled configuration load outcome");
  }
}

/** Values in effect for one outcome — record on success, declared defaults otherwise. */
export function configurationValuesFromLoadOutcome(
  outcome: ConfigurationLoadOutcome,
  registry: ConfigurationRegistryPort,
): ConfigurationValues {
  if (outcome.kind === "published" || outcome.kind === "unchanged") {
    return outcome.record.values;
  }
  return registry.defaults();
}

export type ProductConfigurationLoadResult = {
  readonly outcome: ConfigurationLoadOutcome;
  readonly generation: ConfigurationGeneration;
  readonly values: ConfigurationValues;
};

/** Load through the service graph's loader and derive generation + values. */
export async function loadProductConfiguration(
  graph: Services,
  request: ProductConfigurationLoadRequest,
  signal?: AbortSignal,
): Promise<ProductConfigurationLoadResult> {
  const outcome = await graph.loader.load(
    {
      configurationRoot: graph.configurationRoot,
      legacyConfigurationRoot: graph.legacyConfigurationRoot,
      workspaceRoot: graph.workspaceRoot,
      profile: request.profile,
      overrides: request.overrides,
    },
    signal,
  );
  return {
    outcome,
    generation: configurationGenerationFromLoadOutcome(outcome, graph.loader),
    values: configurationValuesFromLoadOutcome(outcome, graph.registry),
  };
}
