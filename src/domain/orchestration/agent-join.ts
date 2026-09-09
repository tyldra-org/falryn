/** Parent-owned integration facts. Executors and artifact bytes stay with their existing owners. */
import { z } from "zod";
import { digestSchema, identityText } from "../extensions/identity.ts";
import type { Result } from "../foundation/result.ts";
import { processTaskHandleSchema } from "./process-task.ts";

export const JOIN_LIMITS = { children: 16, perParent: 64, retained: 256, bytes: 65536 } as const;
export const agentGenerationSchema = z.strictObject({
  taskId: identityText,
  generation: z.int().min(1).max(64),
  task: processTaskHandleSchema,
});
export const joinOwnerSchema = z.strictObject({
  sessionId: identityText,
  turnId: identityText,
  taskId: identityText,
  generation: z.int().min(1).max(64),
  workspaceId: identityText,
});
export type JoinOwner = z.infer<typeof joinOwnerSchema>;
export const joinPolicySchema = z.strictObject({
  mode: z.enum(["all", "first-success", "quorum"]),
  quorum: z.int().min(1).max(JOIN_LIMITS.children).nullable(),
  partialOnFailure: z.boolean(),
  cancelRemaining: z.boolean(),
});
export const joinInputSchema = z
  .strictObject({
    id: identityText,
    generation: z.int().min(1).max(64),
    children: z.array(agentGenerationSchema).min(1).max(JOIN_LIMITS.children),
    policy: joinPolicySchema,
  })
  .superRefine((input, ctx) => {
    if (new Set(input.children.map((child) => child.taskId)).size !== input.children.length)
      ctx.addIssue({ code: "custom", message: "select each child once" });
    if (
      input.policy.mode === "quorum"
        ? input.policy.quorum === null || input.policy.quorum > input.children.length
        : input.policy.quorum !== null
    )
      ctx.addIssue({ code: "custom", message: "quorum is required only for quorum policy" });
  });
export type JoinInput = z.infer<typeof joinInputSchema>;
export const agentLinkSchema = z.strictObject({
  handle: agentGenerationSchema,
  owner: joinOwnerSchema,
  rootTaskId: identityText,
  rootSessionId: identityText,
  required: z.boolean(),
  definitionDigest: digestSchema,
  resultSchema: z.json(),
  detached: z.boolean(),
});
export type AgentLink = z.infer<typeof agentLinkSchema>;
export const joinEvidenceSchema = z.strictObject({
  handle: agentGenerationSchema,
  state: z.enum([
    "running",
    "missing",
    "stale",
    "invalid",
    "completed",
    "failed",
    "cancelled",
    "timed-out",
    "uncertain",
  ]),
  effect: z.enum(["none", "partial", "completed", "uncertain"]),
  resultDigest: digestSchema.nullable(),
  artifactId: identityText.nullable(),
  sequence: z.int().positive().nullable(),
});
export type JoinEvidence = z.infer<typeof joinEvidenceSchema>;
export const joinIntegrationSchema = z.enum([
  "accepted",
  "rejected",
  "partial",
  "follow-up-required",
]);
export const joinRecordSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("agent-join"),
  owner: joinOwnerSchema,
  input: joinInputSchema,
  revision: z.int().min(1).max(3),
  state: z.enum(["waiting", "satisfied", "failed", "cancelled"]),
  evidence: z.array(joinEvidenceSchema).max(JOIN_LIMITS.children),
  selected: z.array(identityText).max(JOIN_LIMITS.children),
  integration: joinIntegrationSchema.nullable(),
  continuation: identityText.nullable(),
});
export type JoinRecord = z.infer<typeof joinRecordSchema>;
export const descendantFactSchema = z.strictObject({
  handle: agentGenerationSchema,
  required: z.boolean(),
  detached: z.boolean(),
  state: joinEvidenceSchema.shape.state,
  effect: joinEvidenceSchema.shape.effect,
  integration: z.enum(["unjoined", "accepted", "not-accepted"]),
});
export const joinCompletionSchema = z.strictObject({
  complete: z.boolean(),
  joins: z.array(identityText).max(JOIN_LIMITS.perParent),
  effect: z.enum(["none", "completed", "partial", "uncertain"]),
  children: z.array(descendantFactSchema).max(64),
});
export type JoinCompletion = z.infer<typeof joinCompletionSchema>;
export type JoinFailure = {
  readonly code:
    | "invalid"
    | "foreign-parent"
    | "stale"
    | "closed"
    | "busy"
    | "capacity"
    | "not-found"
    | "conflict"
    | "corrupt"
    | "unavailable"
    | "cancelled"
    | "uncertain";
};
export type JoinResult<T> = Result<T, JoinFailure>;
export type JoinStore = {
  register(link: AgentLink): JoinResult<AgentLink>;
  link(handle: z.infer<typeof agentGenerationSchema>): JoinResult<AgentLink>;
  taskLink(handle: z.infer<typeof processTaskHandleSchema>): JoinResult<AgentLink | null>;
  children(owner: JoinOwner): JoinResult<readonly AgentLink[]>;
  create(owner: JoinOwner, input: JoinInput): JoinResult<JoinRecord>;
  get(owner: JoinOwner, input: Pick<JoinInput, "id" | "generation">): JoinResult<JoinRecord>;
  /** Recheck exact terminal handles and sequence under the writer before freezing evidence. */
  settle(
    record: JoinRecord,
    evidence: readonly JoinEvidence[],
    cancel: boolean,
  ): JoinResult<JoinRecord>;
  integrate(
    record: JoinRecord,
    integration: z.infer<typeof joinIntegrationSchema>,
  ): JoinResult<JoinRecord>;
  detach(link: AgentLink, detached: boolean): JoinResult<AgentLink>;
  finish(owner: JoinOwner): JoinResult<JoinCompletion>;
  finishTurn(sessionId: string, turnId: string): JoinResult<JoinCompletion>;
  finishAgent(taskId: string, generation: number): JoinResult<JoinCompletion>;
  notificationBoundary(handle: z.infer<typeof processTaskHandleSchema>): JoinResult<boolean>;
  cleanup(owner: JoinOwner, input: Pick<JoinInput, "id" | "generation">): JoinResult<null>;
  sealSequence(handle: z.infer<typeof processTaskHandleSchema>): JoinResult<number | null>;
};

/** Called over one writer snapshot; ordering never depends on Promise delivery order. */
export function evaluateJoin(
  input: JoinInput,
  links: readonly AgentLink[],
  evidence: readonly JoinEvidence[],
): Pick<JoinRecord, "state" | "selected"> {
  const valid = evidence.filter(
    (item) =>
      item.state === "completed" &&
      item.effect !== "uncertain" &&
      item.resultDigest !== null &&
      item.sequence !== null,
  );
  valid.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const required = links.filter((link) => link.required && !link.detached);
  const requiredStates = required.map((link) => {
    const item = evidence.find((item) => item.handle.taskId === link.handle.taskId);
    return item?.effect === "uncertain" ? "uncertain" : (item?.state ?? "missing");
  });
  const pending = evidence.filter((item) => item.state === "running").length;
  const threshold =
    input.policy.mode === "all"
      ? input.children.length
      : input.policy.mode === "first-success"
        ? 1
        : (input.policy.quorum ?? input.children.length);
  const mandatoryFailed = requiredStates.some(
    (state) => state !== "completed" && state !== "running",
  );
  if (
    !mandatoryFailed &&
    requiredStates.every((state) => state === "completed") &&
    valid.length >= threshold
  )
    return {
      state: "satisfied",
      selected: [
        ...new Set([
          ...valid.slice(0, threshold).map((item) => item.handle.taskId),
          ...required.map((link) => link.handle.taskId),
        ]),
      ],
    };
  if (mandatoryFailed || valid.length + pending < threshold)
    return {
      state: "failed",
      selected: input.policy.partialOnFailure ? valid.map((item) => item.handle.taskId) : [],
    };
  return { state: "waiting", selected: [] };
}
