import { z } from "zod";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import {
  SCHEDULE_OPERATIONS,
  type ScheduleActions,
  scheduleCommandSchema,
} from "../orchestration/schedule-actions.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";
export const SCHEDULE_CAPABILITY = "builtin:orchestration/schedule@1";
export function composeScheduleTool(
  generation: ConfigurationGeneration,
  actions: ScheduleActions,
): ProductToolSourceBundle {
  const entry = createToolRegistryEntry(
    {
      namespace: "orchestration",
      name: "schedule",
      version: 1,
      source: "builtin",
      title: "Inspect and prepare durable schedules",
      description:
        "Create inert schedules and preview, inspect, list, pause, update or cancel exact attempts. Supply commandJson with an operation and its fields. Enable, resume, adoption and trigger-now require an explicit user action. A live Falryn host is required to run enabled work. Registration, import and inspection never execute targets. Results expose metadata and retained result handles, not private inputs.",
      effect: "observation",
      capabilityKind: "other",
      platforms: [],
      limits: defaultToolLimits({
        maxInputBytes: 1_122_304,
        maxOutputBytes: 65_536,
        defaultTimeoutMs: 30000,
      }),
      concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
      resultProjection: defaultProjectionContract({ modelMaxBytes: 65_536 }),
    },
    {
      inputSchema: z.strictObject({
        operation: z.enum(SCHEDULE_OPERATIONS),
        commandJson: z.string().max(1_114_112),
      }),
      outputSchema: z.record(z.string(), z.unknown()),
      effectFor: (input) =>
        ["validate", "preview", "inspect", "list", "history", "delete-preview"].includes(
          String(input.operation),
        )
          ? "observation"
          : "mutation",
    },
  );
  if (!entry.ok) throw new Error("schedule-tool-registration-invalid");
  const registry = createToolRegistry(generation, [entry.value]);
  if (!registry.ok) throw new Error("schedule-registry-invalid");
  return {
    registry: registry.value,
    catalog: registry.value.catalog,
    toolNames: ["schedule"],
    runner: {
      hasBinding: (id) => String(id) === SCHEDULE_CAPABILITY,
      async execute(request) {
        if (!request.afterAdmission)
          return { status: "unavailable", reason: "schedule-admission-required", effect: "none" };
        let command: unknown;
        try {
          command = JSON.parse(String(request.input.commandJson));
        } catch {
          return { status: "malformed", reason: "schedule-command-invalid", effect: "none" };
        }
        const parsed = scheduleCommandSchema.safeParse(command);
        if (!parsed.success || parsed.data.operation !== request.input.operation)
          return { status: "malformed", reason: "schedule-operation-mismatch", effect: "none" };
        request.afterAdmission(async (signal) => {
          const result = await actions.execute(parsed.data, "model", signal);
          return result.ok
            ? { status: "completed", effect: "completed", output: result.value }
            : { status: "unavailable", effect: "none", reason: `schedule-${result.error.code}` };
        });
        return {
          status: "completed",
          effect: "completed",
          output: { kind: "schedule-metadata-admitted" },
        };
      },
    },
  };
}
