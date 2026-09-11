/** Typed JSON authoring is inert; explicit execution uses the workflow action owner. */
import { z } from "zod";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import { WORKFLOW_LIMITS } from "../../domain/orchestration/workflow-definition.ts";
import { workflowHandleSchema } from "../../domain/orchestration/workflow-state.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { type WorkflowActions, workflowCommandSchema } from "../orchestration/workflow-actions.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

export const WORKFLOW_CAPABILITY = "builtin:orchestration/workflow@1";
const inputSchema = z
  .strictObject({
    operation: z.enum([
      "validate",
      "preview",
      "execute",
      "inspect",
      "result",
      "resume",
      "pause",
      "cancel",
      "list",
    ]),
    modelJson: z.string().max(16384).optional(),
    stepsJson: z.string().max(65536).optional(),
    definitionJson: z.string().max(WORKFLOW_LIMITS.definitionBytes).optional(),
    argumentsJson: z.string().max(WORKFLOW_LIMITS.valueBytes).optional(),
    handle: workflowHandleSchema.optional(),
    reuse: workflowHandleSchema.optional(),
    after: workflowHandleSchema.optional(),
    expectedRevision: z.int().positive().optional(),
    offset: z.int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    if (!decodeCommand(value))
      context.addIssue({ code: "custom", message: "Fields do not match the workflow operation." });
  });
function decodeCommand(input: Readonly<Record<string, unknown>>) {
  try {
    const { definitionJson, argumentsJson, modelJson, stepsJson, ...rest } = input;
    const result = workflowCommandSchema.safeParse({
      ...rest,
      ...(typeof modelJson === "string" ? { model: JSON.parse(modelJson) } : {}),
      ...(typeof stepsJson === "string" ? { steps: JSON.parse(stepsJson) } : {}),
      ...(typeof definitionJson === "string" ? { definition: JSON.parse(definitionJson) } : {}),
      ...(typeof argumentsJson === "string" ? { arguments: JSON.parse(argumentsJson) } : {}),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
export function composeWorkflowTool(
  generation: ConfigurationGeneration,
  actions: WorkflowActions,
): ProductToolSourceBundle {
  const entry = createToolRegistryEntry(
    {
      namespace: "orchestration",
      name: "workflow",
      version: 1,
      source: "builtin",
      title: "Validate or execute a typed workflow",
      description:
        "Validate and preview a version 1 JSON graph without effects. Explicit execute snapshots the supplied definition, arguments and run handle before running declared native, model, agent and question nodes. Use exact handles for inspect, result, pause, resume or cancel. Results contain retained artifact handles. Uncertain effects are never replayed. Preview is not permission to execute.",
      effect: "observation",
      capabilityKind: "other",
      platforms: [],
      limits: defaultToolLimits({
        maxInputBytes: WORKFLOW_LIMITS.definitionBytes + WORKFLOW_LIMITS.valueBytes + 4096,
        maxOutputBytes: WORKFLOW_LIMITS.valueBytes,
        defaultTimeoutMs: 30000,
      }),
      concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
      resultProjection: defaultProjectionContract({ modelMaxBytes: WORKFLOW_LIMITS.valueBytes }),
    },
    {
      inputSchema,
      outputSchema: z.record(z.string(), z.unknown()),
      effectFor(input) {
        const command = decodeCommand(input);
        // Coordination admits metadata only. Each child independently re-enters
        // the native gateway for its actual effect and focused confirmation.
        if (command?.operation === "execute") return "observation";
        return command && ["pause", "cancel", "resume"].includes(command.operation)
          ? "mutation"
          : "observation";
      },
    },
  );
  if (!entry.ok) throw new Error(`workflow-registration-${entry.error.code}`);
  const registry = createToolRegistry(generation, [entry.value]);
  if (!registry.ok) throw new Error(`workflow-registry-${registry.error.code}`);
  return {
    registry: registry.value,
    catalog: registry.value.catalog,
    toolNames: ["workflow"],
    runner: {
      hasBinding: (id) => String(id) === WORKFLOW_CAPABILITY,
      async execute(request) {
        const command = decodeCommand(request.input);
        if (!command || !request.afterAdmission)
          return {
            status: "unavailable",
            effect: "none",
            reason: "workflow-admission-owner-required",
          };
        request.afterAdmission((signal) => actions.execute(command, { ...request, signal }));
        return {
          status: "completed",
          effect: "completed",
          output: { kind: "workflow-metadata-admitted" },
        };
      },
    },
  };
}
