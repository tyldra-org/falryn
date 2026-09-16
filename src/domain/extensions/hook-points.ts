/** Closed v1 hook descriptions. A codec is not a composed semantic publisher. */
import { z } from "zod";
import { freezeMetadata } from "./canonical.ts";

export const HOOK_VERSION = 1;
export const HOOK_LIMITS = Object.freeze({
  inputBytes: 65_536,
  responseBytes: 16_384,
  diagnosticBytes: 16_384,
  registrationsPerPoint: 32,
  recursionDepth: 1,
  annotationKeys: 8,
  annotationValueLength: 120,
  evidenceEntries: 8,
  evidenceBytes: 8_192,
  filterCount: 32,
  filterValueLength: 256,
});
export const HOOK_BUDGETS = Object.freeze({
  local: Object.freeze({ defaultMs: 50, maximumMs: 1_000, chainMs: 2_000 }),
  remote: Object.freeze({ defaultMs: 5_000, maximumMs: 10_000, chainMs: 20_000 }),
  evaluator: Object.freeze({ defaultMs: 10_000, maximumMs: 30_000, chainMs: 60_000 }),
  mixedChainMs: 60_000,
});
export const hookIdentity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u);
export const hookGeneration = z.int().nonnegative();
export const hookDigest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/u);
export const hookTerminal = z.enum(["completed", "failed", "cancelled", "timed-out", "uncertain"]);
export const hookEffect = z.enum(["none", "completed", "partial", "uncertain"]);
const provenance = z.strictObject({ sourceId: hookIdentity, digest: hookDigest });
const terminal = { terminal: hookTerminal, effect: hookEffect };
const processing = z.strictObject({
  requested: hookIdentity,
  resolved: hookIdentity,
  actual: hookIdentity.nullable(),
  disposition: z.enum(["pending", "applied", "downgraded", "unavailable"]),
});
const input = z.strictObject({
  inputId: hookIdentity,
  contentDigest: hookDigest,
  source: provenance,
});
const context = z.strictObject({
  contextId: hookIdentity,
  generation: hookGeneration,
  itemCount: z.int().nonnegative(),
  contentDigest: hookDigest,
});
const binding = z.strictObject({ bindingId: hookIdentity, generation: hookGeneration, processing });
const attempt = z.strictObject({ attemptId: hookIdentity, bindingId: hookIdentity, processing });
const tool = z.strictObject({
  capabilityId: hookIdentity,
  inputDigest: hookDigest,
  declaredEffect: z.enum(["observation", "mutation", "external", "interactive"]),
});
const confirmation = z.strictObject({ invocationId: hookIdentity, fingerprint: hookDigest });
const artifact = z.strictObject({
  artifactId: hookIdentity,
  digest: hookDigest,
  bytes: z.int().nonnegative(),
});
const extension = z.strictObject({
  contributionId: hookIdentity,
  generation: hookGeneration,
  source: provenance,
});
const environment = z.strictObject({
  candidateId: hookIdentity,
  scopeId: hookIdentity,
  generation: hookGeneration,
});
const message = z.strictObject({ messageId: hookIdentity, contentDigest: hookDigest });
const worktree = z.strictObject({
  operationId: hookIdentity,
  workspaceId: hookIdentity,
  ...terminal,
});
const child = z.strictObject({
  childId: hookIdentity,
  parentId: hookIdentity,
  generation: hookGeneration,
});
const task = z.strictObject({
  taskId: hookIdentity,
  revision: hookGeneration,
  affectedNodeIds: z.array(hookIdentity).min(1).max(128),
  source: provenance,
});
const elicitation = z.strictObject({
  serverId: hookIdentity,
  requestId: hookIdentity,
  transportGeneration: hookGeneration,
  schemaDigest: hookDigest,
});

type Policy = "gate" | "evidence" | "observe" | "completion" | "local-observe";
function point<S extends z.ZodObject>(
  payload: S,
  producer: string,
  phase: "pre" | "post" | "terminal",
  policy: Policy,
  options: {
    evaluatorGate?: boolean;
    mutableFields?: readonly string[];
    filters?: readonly string[];
  } = {},
) {
  return Object.freeze({
    version: HOOK_VERSION,
    payload,
    producer,
    phase,
    policy,
    evaluatorGate: options.evaluatorGate ?? false,
    mutableFields: Object.freeze([...(options.mutableFields ?? [])]),
    filters: Object.freeze([
      ...(options.filters ??
        Object.keys(payload.shape).filter((key) => {
          const schema = payload.shape[key];
          return (
            schema instanceof z.ZodString ||
            schema instanceof z.ZodNumber ||
            schema instanceof z.ZodEnum ||
            schema instanceof z.ZodLiteral
          );
        })),
    ]),
    decisions: Object.freeze([
      "observe",
      ...(phase === "pre" && (policy === "gate" || policy === "evidence")
        ? ["veto", "external-effect-request"]
        : []),
      ...(options.mutableFields?.includes("annotations") ? ["transform"] : []),
      ...(policy === "observe" || policy === "completion" ? ["external-effect-request"] : []),
    ]),
    failurePosture:
      phase === "pre" && (policy === "gate" || policy === "evidence")
        ? ("fail-closed" as const)
        : ("fail-open" as const),
    deadline: "narrow-enclosing-deadline" as const,
    cancellation: "inherit-owner" as const,
    orderingKey: "point/source/identity/registrationGeneration" as const,
    sensitiveFields:
      "content-is-digest-only; no credentials, environment, callbacks or runtime objects" as const,
    observationEvent: "hook-point-entered" as const,
    outcomeEvent: "hook-point-settled" as const,
  });
}

export const HOOK_POINTS = Object.freeze({
  "session.start": point(
    z.strictObject({
      sessionId: hookIdentity,
      generation: hookGeneration,
      reason: z.enum(["fresh", "resume", "fork"]),
    }),
    "session.activation",
    "post",
    "observe",
  ),
  "session.end": point(
    z.strictObject({ sessionId: hookIdentity, ...terminal }),
    "session.shutdown",
    "terminal",
    "local-observe",
  ),
  "turn.start": point(
    z.strictObject({ turnId: hookIdentity }),
    "turn.admission",
    "post",
    "observe",
  ),
  "turn.complete": point(
    z.strictObject({ turnId: hookIdentity, ...terminal }),
    "turn.settlement",
    "terminal",
    "completion",
  ),
  "task.create": point(
    task.extend({ nodeKind: z.enum(["work-item", "group"]) }),
    "task.commit",
    "post",
    "observe",
  ),
  "task.complete": point(
    task.extend({ nodeKind: z.literal("work-item"), ...terminal }),
    "task.acceptance",
    "terminal",
    "completion",
  ),
  "workflow.complete": point(
    z.strictObject({ workflowId: hookIdentity, ...terminal }),
    "workflow.settlement",
    "terminal",
    "completion",
  ),
  "user.submit": point(input, "input.admission", "pre", "evidence", {
    evaluatorGate: true,
    mutableFields: ["contextEvidence"],
  }),
  "user.prompt.expand": point(input, "prompt.expansion", "pre", "evidence", {
    evaluatorGate: true,
    mutableFields: ["contextEvidence"],
  }),
  "instructions.loaded": point(
    context.extend({ source: provenance }),
    "instructions.admission",
    "post",
    "evidence",
    { mutableFields: ["contextEvidence"] },
  ),
  "context.plan.before": point(context, "context.planning", "pre", "evidence", {
    mutableFields: ["contextEvidence"],
  }),
  "context.plan.after": point(context, "context.planning", "post", "observe"),
  "context.compact.before": point(
    context.extend({ attemptId: hookIdentity }),
    "context.compaction",
    "pre",
    "observe",
  ),
  "context.compact.after": point(
    context.extend({ attemptId: hookIdentity, checkpointId: hookIdentity.nullable(), ...terminal }),
    "context.compaction",
    "post",
    "observe",
  ),
  "model.switch.before": point(binding, "model.publication", "pre", "gate", {
    evaluatorGate: true,
  }),
  "model.switch.after": point(binding, "model.publication", "post", "observe"),
  "provider.attempt.before": point(attempt, "provider.dispatch", "pre", "observe"),
  "provider.attempt.after": point(
    attempt.extend(terminal),
    "provider.settlement",
    "post",
    "observe",
  ),
  "before-capability-invocation": point(tool, "tool.gateway", "pre", "gate", {
    evaluatorGate: true,
    mutableFields: ["annotations"],
  }),
  "after-capability-invocation": point(tool.extend(terminal), "tool.gateway", "post", "observe"),
  "capability.disclose.before": point(
    z.strictObject({
      catalogGeneration: hookGeneration,
      capabilityIds: z.array(hookIdentity).max(128),
    }),
    "capability.disclosure",
    "pre",
    "observe",
  ),
  "capability.invoke.failure": point(
    tool.extend({ terminal: hookTerminal.exclude(["completed"]), effect: hookEffect }),
    "tool.failure-view",
    "post",
    "observe",
  ),
  "capability.batch.complete": point(
    z.strictObject({
      batchId: hookIdentity,
      members: z.array(z.strictObject({ invocationId: hookIdentity, ...terminal })).max(128),
    }),
    "tool.batch-settlement",
    "post",
    "observe",
  ),
  "confirmation.request": point(confirmation, "confirmation.request", "pre", "gate"),
  "confirmation.denied": point(confirmation, "confirmation.denial", "post", "observe"),
  "artifact.retain.before": point(artifact, "artifact.retention", "pre", "observe"),
  "artifact.export.before": point(artifact, "artifact.export", "pre", "observe"),
  "extension.connect": point(extension, "extension.connection", "post", "observe"),
  "extension.catalog.change": point(extension, "extension.catalog", "post", "observe"),
  "mcp.elicitation": point(elicitation, "mcp.question", "pre", "observe"),
  "mcp.elicitation.result": point(
    elicitation.extend({ disposition: z.enum(["accept", "decline", "cancel", "timeout"]) }),
    "mcp.answer",
    "post",
    "observe",
  ),
  "job.start": point(
    z.strictObject({ jobId: hookIdentity, generation: hookGeneration }),
    "job.admission",
    "post",
    "observe",
  ),
  "job.stop": point(
    z.strictObject({ jobId: hookIdentity, ...terminal }),
    "job.settlement",
    "terminal",
    "local-observe",
  ),
  "subagent.start": point(child, "child.admission", "post", "observe"),
  "subagent.stop": point(child.extend(terminal), "child.settlement", "terminal", "completion"),
  "agent.idle": point(
    z.strictObject({
      agentId: hookIdentity,
      lineageId: hookIdentity,
      state: z.literal("eligible-idle"),
    }),
    "agent.idle",
    "post",
    "local-observe",
  ),
  "workspace.cwd.change": point(
    z.strictObject({ workspaceId: hookIdentity, generation: hookGeneration, rootId: hookIdentity }),
    "workspace.binding",
    "post",
    "observe",
  ),
  "workspace.root.add": point(
    z.strictObject({ workspaceId: hookIdentity, generation: hookGeneration, rootId: hookIdentity }),
    "workspace.roots",
    "post",
    "observe",
  ),
  "workspace.file.change": point(
    z.strictObject({
      workspaceId: hookIdentity,
      generation: hookGeneration,
      paths: z
        .array(
          z
            .string()
            .min(1)
            .max(1_024)
            .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..")),
        )
        .max(128),
      disposition: z.enum(["current", "rescan-required", "duplicate-uncertain"]),
    }),
    "workspace.watch",
    "post",
    "observe",
    { filters: ["workspaceId", "paths", "disposition"] },
  ),
  "worktree.create": point(worktree, "git.worktree-create", "post", "observe"),
  "worktree.remove": point(worktree, "git.worktree-remove", "post", "observe"),
  "configuration.change": point(
    z.strictObject({
      generation: hookGeneration,
      disposition: z.enum(["observed", "applied", "rejected", "pending"]),
      changedKeys: z.array(hookIdentity).max(128),
    }),
    "configuration.publication",
    "post",
    "observe",
  ),
  "environment.prepare.before": point(environment, "environment.preparation", "pre", "observe"),
  "environment.prepare.after": point(
    environment.extend({ disposition: z.enum(["prepared", "failed", "cancelled", "timed-out"]) }),
    "environment.preparation",
    "post",
    "observe",
  ),
  "notification.publish": point(message, "notification.publication", "post", "observe"),
  "message.project": point(message, "message.projection", "post", "local-observe"),
  "diagnostic.project": point(
    z.strictObject({
      diagnosticId: hookIdentity,
      code: hookIdentity,
      level: z.enum(["info", "warning", "error"]),
    }),
    "diagnostic.projection",
    "post",
    "local-observe",
  ),
});
export type HookPoint = keyof typeof HOOK_POINTS;
export type HookPayload<P extends HookPoint> = z.infer<(typeof HOOK_POINTS)[P]["payload"]>;
export const hookPointSchema = z.enum(Object.keys(HOOK_POINTS) as [HookPoint, ...HookPoint[]]);
export const LIVE_TOOL_HOOK_POINTS = [
  "before-capability-invocation",
  "after-capability-invocation",
] as const satisfies readonly HookPoint[];

/** The existing gateway is the only publisher composed by this catalog slice. */
export function inspectHookPoints() {
  return Object.entries(HOOK_POINTS).map(([name, descriptor]) => ({
    point: name,
    version: descriptor.version,
    phase: descriptor.phase,
    producer: descriptor.producer,
    availability:
      descriptor.producer === "tool.gateway" ? ("available" as const) : ("unavailable" as const),
    publisher:
      descriptor.producer === "tool.gateway"
        ? "src/application/tools/product-tool-gateway.ts#hookEnvelope"
        : null,
    mutableFields: descriptor.mutableFields,
    filters: descriptor.filters,
    policy: descriptor.policy,
    decisions: descriptor.decisions,
    deadline: descriptor.deadline,
    cancellation: descriptor.cancellation,
    orderingKey: descriptor.orderingKey,
    sensitiveFields: descriptor.sensitiveFields,
    failurePosture: descriptor.failurePosture,
    observationEvent: descriptor.observationEvent,
    outcomeEvent: descriptor.outcomeEvent,
    inputSchema: z.toJSONSchema(descriptor.payload),
  }));
}

const correlation = z.strictObject({
  sessionId: hookIdentity.nullable(),
  turnId: hookIdentity.nullable(),
  attemptId: hookIdentity.nullable(),
});
export const hookEnvelopeHeader = z.strictObject({
  version: z.literal(HOOK_VERSION),
  point: hookPointSchema,
  pointVersion: z.literal(HOOK_VERSION),
  factId: hookIdentity,
  subjectId: hookIdentity,
  ownerGeneration: hookGeneration,
  configurationGeneration: hookGeneration,
  registrationGeneration: hookGeneration,
  sequence: z.int().nonnegative(),
  correlation,
  origin: z.enum(["user", "model", "system", "hook", "evaluator"]),
  reason: z.enum(["normal", "user-stop", "shutdown", "recovery"]),
  remainingMs: z.int().nonnegative().max(1_800_000),
  recursionDepth: z.int().nonnegative().max(HOOK_LIMITS.recursionDepth),
});
export type HookEnvelope<P extends HookPoint = HookPoint> = P extends HookPoint
  ? Readonly<z.infer<typeof hookEnvelopeHeader> & { point: P; payload: Readonly<HookPayload<P>> }>
  : never;

export function parseHookEnvelope(input: unknown): HookEnvelope {
  const raw = hookEnvelopeHeader.extend({ payload: z.unknown() }).parse(input);
  const payload = HOOK_POINTS[raw.point].payload.parse(raw.payload);
  // The point-specific parse above establishes the discriminated relationship.
  return freezeMetadata({ ...raw, payload }) as HookEnvelope;
}
