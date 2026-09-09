/** Versioned control inputs and immutable child-result facts. */
import { z } from "zod";
import { digestSchema, identityText } from "../../domain/extensions/identity.ts";
import { childAuthoritySchema } from "../../domain/orchestration/child-admission.ts";
import {
  processTaskExecutionSchema,
  processTaskHandleSchema,
} from "../../domain/orchestration/process-task.ts";
import { resourceAmountsSchema } from "../../domain/orchestration/resource-admission.ts";
import { EFFECT_CLASSES } from "../../domain/orchestration/work.ts";
import { roleRouteBaseSchema } from "../../providers/configuration/policy-schema.ts";
import {
  agentContextItemSchema,
  MAX_AGENT_CONTEXT_BYTES,
  MAX_AGENT_STEERING_BYTES,
} from "./agent-definition.ts";

export const agentHandleSchema = z.strictObject({
  taskId: identityText,
  generation: z.int().positive(),
  task: processTaskHandleSchema.optional(),
});
export type AgentHandle = z.infer<typeof agentHandleSchema>;
const launch = {
  definitionId: identityText,
  inputJson: z.string().min(1).max(MAX_AGENT_CONTEXT_BYTES),
  context: z.array(agentContextItemSchema).max(64),
  capabilities: z.array(identityText).max(256),
  effects: z.array(z.enum(EFFECT_CLASSES)).max(4),
  limits: resourceAmountsSchema,
  execution: processTaskExecutionSchema,
  model: roleRouteBaseSchema.optional(),
  name: identityText.optional(),
};
export const delegationCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("list"),
    search: z.string().max(256).default(""),
    offset: z.int().nonnegative().default(0),
  }),
  z.strictObject({ operation: z.literal("definition"), definitionId: identityText }),
  z.strictObject({ operation: z.literal("resolve"), name: identityText }),
  z.strictObject({ operation: z.literal("launch"), ...launch }),
  z.strictObject({
    operation: z.literal("continue"),
    handle: agentHandleSchema,
    inputJson: launch.inputJson,
    context: launch.context,
  }),
  z.strictObject({
    operation: z.literal("steer"),
    handle: agentHandleSchema,
    text: z.string().min(1).max(MAX_AGENT_STEERING_BYTES),
  }),
  z.strictObject({ operation: z.literal("inspect"), handle: agentHandleSchema }),
  z.strictObject({ operation: z.literal("result"), handle: agentHandleSchema }),
  z.strictObject({
    operation: z.literal("wait"),
    handle: agentHandleSchema,
    waitMs: z.int().min(1).max(30000),
  }),
  z.strictObject({
    operation: z.literal("detach"),
    handle: agentHandleSchema,
    expectedRevision: z.int().positive(),
  }),
  z.strictObject({
    operation: z.literal("reattach"),
    handle: agentHandleSchema,
    expectedRevision: z.int().positive(),
  }),
  z.strictObject({
    operation: z.literal("cancel"),
    handle: agentHandleSchema,
    expectedRevision: z.int().positive(),
  }),
  z.strictObject({
    operation: z.literal("cleanup"),
    handle: agentHandleSchema,
    expectedRevision: z.int().positive(),
  }),
]);
export type DelegationCommand = z.infer<typeof delegationCommandSchema>;
export type AgentLaunch = Extract<DelegationCommand, { operation: "launch" }>;

export const sealedAgentResultSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("agent-result"),
  handle: agentHandleSchema,
  parent: z.strictObject({ sessionId: identityText, turnId: identityText, taskId: identityText }),
  rootTaskId: identityText,
  definitionId: identityText,
  definitionDigest: digestSchema,
  preparationDigest: digestSchema,
  preparation: z.strictObject({
    route: roleRouteBaseSchema,
    source: identityText,
    execution: childAuthoritySchema,
    context: z.array(agentContextItemSchema.omit({ text: true })).max(64),
    omitted: z.array(z.strictObject({ id: identityText, reason: identityText })).max(256),
  }),
  previousResultDigest: digestSchema.nullable(),
  resultDigest: digestSchema,
  outcome: z.enum(["completed", "failed", "cancelled", "timed-out", "uncertain"]),
  effect: z.enum(["none", "partial", "completed", "uncertain"]),
  claims: z.json().nullable(),
  reason: identityText,
  /** This envelope seals observations; it never verifies the parent's broader objective. */
  parentVerification: z.literal("not-asserted"),
  observationRefs: z.array(identityText).max(512),
  omittedObservationRefs: z.int().nonnegative(),
  providerRequests: z.int().nonnegative(),
  usage: z.json().nullable(),
  steering: z
    .array(z.strictObject({ id: identityText, state: z.enum(["admitted", "missed-terminal"]) }))
    .max(64),
});
export type SealedAgentResult = z.infer<typeof sealedAgentResultSchema>;
export const agentTaskLinkSchema = z.strictObject({
  handle: agentHandleSchema,
  task: processTaskHandleSchema,
});
