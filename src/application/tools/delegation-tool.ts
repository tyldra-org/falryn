/** The delegate family publishes only operations backed by its native owner. */
import { z } from "zod";
import { identityText } from "../../domain/extensions/identity.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import { joinInputSchema, joinIntegrationSchema } from "../../domain/orchestration/agent-join.ts";
import { processTaskExecutionSchema } from "../../domain/orchestration/process-task.ts";
import { resourceAmountsSchema } from "../../domain/orchestration/resource-admission.ts";
import { conflictKey, EFFECT_CLASSES } from "../../domain/orchestration/work.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { roleRouteBaseSchema } from "../../providers/configuration/policy-schema.ts";
import {
  agentContextItemSchema,
  MAX_AGENT_CONTEXT_BYTES,
  MAX_AGENT_RESULT_BYTES,
  MAX_AGENT_STEERING_BYTES,
} from "../orchestration/agent-definition.ts";
import {
  agentHandleSchema,
  delegationCommandSchema,
} from "../orchestration/delegation-contract.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

export const DELEGATE_CAPABILITY = "builtin:orchestration/delegate@1";
const operations = [
  "list",
  "definition",
  "resolve",
  "launch",
  "inspect",
  "result",
  "wait",
  "steer",
  "continue",
  "detach",
  "reattach",
  "cancel",
  "cleanup",
  "join",
  "join-inspect",
  "join-integrate",
  "join-cancel",
  "join-cleanup",
] as const;
const inputSchema = z
  .strictObject({
    operation: z.enum(operations),
    definitionId: identityText.optional(),
    inputJson: z.string().min(1).max(MAX_AGENT_CONTEXT_BYTES).optional(),
    context: z.array(agentContextItemSchema).max(64).optional(),
    capabilities: z.array(identityText).max(256).optional(),
    effects: z.array(z.enum(EFFECT_CLASSES)).max(4).optional(),
    limits: z
      .strictObject(
        Object.fromEntries(
          resourceAmountsSchema.keyType.options.map((key) => [
            key,
            resourceAmountsSchema.valueType.optional(),
          ]),
        ),
      )
      .optional(),
    execution: processTaskExecutionSchema.optional(),
    model: z.fromJSONSchema(z.toJSONSchema(roleRouteBaseSchema, { io: "input" })).optional(),
    name: identityText.optional(),
    required: z.boolean().optional(),
    join: joinInputSchema.optional(),
    joinId: identityText.optional(),
    joinGeneration: z.int().min(1).max(64).optional(),
    integration: joinIntegrationSchema.optional(),
    handle: agentHandleSchema.optional(),
    text: z.string().min(1).max(MAX_AGENT_STEERING_BYTES).optional(),
    waitMs: z.int().min(1).max(30000).optional(),
    expectedRevision: z.int().positive().optional(),
    search: z.string().max(256).optional(),
    offset: z.int().nonnegative().optional(),
  })
  .superRefine((value, context) => {
    if (!delegationCommandSchema.safeParse(value).success)
      context.addIssue({ code: "custom", message: "fields do not match the delegation operation" });
  });

export function composeDelegationTool(
  generation: ConfigurationGeneration,
  execute: (request: ToolRunnerRequest) => Promise<ToolInvocationOutcome>,
): ProductToolSourceBundle {
  const entry = createToolRegistryEntry(
    {
      namespace: "orchestration",
      name: "delegate",
      version: 1,
      source: "builtin",
      title: "Delegate bounded work or control a child",
      description:
        "List or inspect exact agent definitions. Launch bounded children with selected evidence, capabilities, effects, limits and foreground/background policy. Attached children are required unless required=false. Create a join with exact child handles and an all, first-success or quorum policy. Use join-inspect until settled, then join-integrate to record accepted, rejected, partial or follow-up-required evidence. Required unaccepted children prevent parent completion. Use child handles for inspect, result, wait, steer, continue, detach, reattach, cancel or cleanup. Missing definitions never fall back to General. inputJson must match the definition schema.",
      effect: "observation",
      capabilityKind: "other",
      platforms: [],
      limits: defaultToolLimits({
        maxInputBytes: MAX_AGENT_CONTEXT_BYTES * 2,
        maxOutputBytes: MAX_AGENT_RESULT_BYTES,
        defaultTimeoutMs: 30000,
      }),
      concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
      resultProjection: defaultProjectionContract({ modelMaxBytes: MAX_AGENT_RESULT_BYTES }),
    },
    {
      inputSchema,
      outputSchema: z.record(z.string(), z.unknown()),
      effectFor(input) {
        if (
          [
            "list",
            "definition",
            "resolve",
            "inspect",
            "result",
            "wait",
            "join",
            "join-inspect",
            "join-integrate",
            "join-cancel",
            "join-cleanup",
          ].includes(String(input.operation))
        )
          return "observation";
        if (input.operation === "launch") {
          const effects = input.effects as string[];
          return effects.includes("interactive")
            ? "interactive"
            : effects.includes("external")
              ? "external"
              : effects.includes("mutation")
                ? "mutation"
                : "observation";
        }
        return "mutation";
      },
      conflictKeysFor: (input) =>
        input.handle
          ? [conflictKey("agent-control", String((input.handle as { taskId: string }).taskId))]
          : [],
    },
  );
  if (!entry.ok) throw new Error(`delegate-registration-${entry.error.code}`);
  const registry = createToolRegistry(generation, [entry.value]);
  if (!registry.ok) throw new Error(`delegate-registry-${registry.error.code}`);
  return {
    registry: registry.value,
    catalog: registry.value.catalog,
    toolNames: ["delegate"],
    runner: {
      hasBinding: (id) => String(id) === DELEGATE_CAPABILITY,
      async execute(request) {
        if (!request.afterAdmission)
          return {
            status: "unavailable",
            reason: "delegation-admission-owner-required",
            effect: "none",
          };
        request.afterAdmission(async (signal) => {
          const outcome = await execute({ ...request, signal });
          return outcome.status === "unavailable"
            ? {
                status: "completed",
                effect: "completed",
                output: {
                  kind:
                    request.input.operation === "launch"
                      ? "agent-unstarted"
                      : "agent-control-refused",
                  reason: outcome.reason,
                  effect: "none",
                },
              }
            : outcome;
        });
        return {
          status: "completed",
          effect: "completed",
          output: { kind: "delegation-metadata-admitted" },
        };
      },
    },
  };
}
