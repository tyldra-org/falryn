/** Bounded named-route actions through the existing tool admission and settings owners. */
import { z } from "zod";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import type { ModelSettingsService } from "../providers/model-settings.ts";
import { routeSettingsRequests } from "../providers/route-settings.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

export const MODEL_ROUTE_CAPABILITY = "builtin:providers/model_routes@1";
export function composeModelRouteTool(
  generation: ConfigurationGeneration,
  service: ModelSettingsService,
): ProductToolSourceBundle {
  const entry = createToolRegistryEntry(
    {
      namespace: "providers",
      name: "model_routes",
      version: 1,
      source: "builtin",
      title: "Named model routes",
      description:
        "Inspect, validate or simulate explicitly approved model destinations. Save/reset requires mutation admission and an exact settings revision. Supply a route action as commandJson. This never probes or submits a model request. Select a route through the user model settings service.",
      effect: "observation",
      capabilityKind: "other",
      platforms: [],
      limits: defaultToolLimits({
        maxInputBytes: 1_122_304,
        maxOutputBytes: 65_536,
        defaultTimeoutMs: 30000,
      }),
      concurrency: defaultConcurrencyContract({ maxPerWorkspace: 1 }),
      resultProjection: defaultProjectionContract({ modelMaxBytes: 65_536 }),
    },
    {
      inputSchema: z.strictObject({ commandJson: z.string().max(1_114_112) }),
      outputSchema: z.record(z.string(), z.unknown()),
      effectFor: (input) => {
        try {
          const value: unknown = JSON.parse(String(input.commandJson));
          return routeSettingsRequests.slice(0, 5).some((schema) => schema.safeParse(value).success)
            ? "observation"
            : "mutation";
        } catch {
          return "mutation";
        }
      },
    },
  );
  if (!entry.ok) throw new Error("model-route-registration-invalid");
  const registry = createToolRegistry(generation, [entry.value]);
  if (!registry.ok) throw new Error("model-route-registry-invalid");
  return {
    registry: registry.value,
    catalog: registry.value.catalog,
    toolNames: ["model_routes"],
    runner: {
      hasBinding: (id) => String(id) === MODEL_ROUTE_CAPABILITY,
      async execute(request) {
        if (!request.afterAdmission)
          return { status: "unavailable", reason: "route-admission-required", effect: "none" };
        let command: unknown;
        try {
          command = JSON.parse(String(request.input.commandJson));
        } catch {
          return { status: "malformed", reason: "route-command-invalid", effect: "none" };
        }
        if (!routeSettingsRequests.some((schema) => schema.safeParse(command).success))
          return { status: "malformed", reason: "route-command-invalid", effect: "none" };
        request.afterAdmission(async (signal) => {
          const result = await service.execute(command, signal);
          if (result.kind === "failed" || result.kind === "invalid")
            return {
              status: "unavailable",
              reason: result.kind === "failed" ? result.code : result.message,
              effect: "none",
            };
          return { status: "completed", effect: "completed", output: result };
        });
        return {
          status: "completed",
          effect: "completed",
          output: { kind: "route-action-admitted" },
        };
      },
    },
  };
}
