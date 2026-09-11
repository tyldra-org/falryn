/** Bridges graph nodes to existing native owners. Serialized graphs supply no executable callbacks. */
import { canonicalJson } from "../../domain/extensions/canonical.ts";
import { capabilityId, invocationId } from "../../domain/foundation/index.ts";
import { questionInputSchema } from "../../domain/orchestration/question.ts";
import type {
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowNode,
} from "../../domain/orchestration/workflow-definition.ts";
import type { ToolInvocationOutcome, ToolRegistry } from "../../domain/tools/index.ts";
import type { ModelSelection } from "../../providers/configuration/model-selection.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { agentHandleSchema, sealedAgentResultSchema } from "./delegation-contract.ts";
import type { WorkflowHost, WorkflowNodeOutcome } from "./workflow-host.ts";

export type WorkflowModelBinding = {
  readonly selection: ModelSelection;
  readonly definitionDigest: string | null;
  readonly execute: (
    node: Extract<WorkflowNode, { kind: "model" }>,
    input: Readonly<Record<string, unknown>>,
    request: ToolRunnerRequest,
  ) => Promise<WorkflowNodeOutcome>;
};
export type WorkflowNativeHostOptions = {
  readonly request: ToolRunnerRequest;
  readonly registry: ToolRegistry;
  readonly agents: AgentRegistry;
  readonly models: ReadonlyMap<string, WorkflowModelBinding>;
  readonly authority: string;
  readonly sourceGeneration: string;
  readonly current: WorkflowHost["current"];
  readonly question: WorkflowHost["question"];
  readonly createQuestion: WorkflowHost["execute"];
  readonly fenced: WorkflowHost["fenced"];
  readonly reusable: WorkflowHost["reusable"];
  readonly taskListOwner?: boolean;
};

function nodeOutcome(
  outcome: ToolInvocationOutcome,
  exact?: Readonly<Record<string, unknown>>,
): WorkflowNodeOutcome {
  if (outcome.status === "completed")
    return { state: "completed", effect: outcome.effect, value: exact ?? outcome.output };
  if (outcome.status === "uncertain")
    return { state: "uncertain", effect: "uncertain", reason: "workflow-native-effect-uncertain" };
  return {
    state:
      outcome.status === "cancelled" || outcome.status === "timed-out" ? outcome.status : "failed",
    effect: outcome.effect,
    reason:
      "reason" in outcome &&
      typeof outcome.reason === "string" &&
      /^[a-z0-9-]{1,120}$/.test(outcome.reason)
        ? `workflow-native-${outcome.reason}`
        : "workflow-native-operation-refused",
  };
}

export function createWorkflowNativeHost(options: WorkflowNativeHostOptions): WorkflowHost | null {
  const { request, registry, models, agents } = options;
  const owner = request.processTask?.owner;
  const resources = request.taskResources;
  const invoke = request.invokeCapability;
  if (!owner || !resources || !invoke) return null;
  const entryFor = (id: string) => registry.resolveByCapabilityId(capabilityId.from(id));
  function validate(definition: WorkflowDefinition): readonly WorkflowDiagnostic[] {
    const diagnostics: WorkflowDiagnostic[] = [];
    if (definition.taskList && !options.taskListOwner)
      diagnostics.push({ path: "taskList", code: "workflow-task-list-owner-unavailable" });
    for (const node of definition.nodes) {
      if (node.kind === "action") {
        const entry = entryFor(node.capability);
        if (
          !entry ||
          node.capability === "builtin:orchestration/workflow@1" ||
          !request.delegation?.capabilities.includes(node.capability) ||
          !request.delegation.effects.includes(node.effect)
        )
          diagnostics.push({ path: node.key, code: "workflow-capability-unavailable" });
        if (entry && Object.values(node.input).every((value) => value.from === "literal")) {
          const input = Object.fromEntries(
            Object.entries(node.input).map(([key, value]) => [
              key,
              value.from === "literal" ? value.value : null,
            ]),
          );
          const parsed = entry.manifest.inputSchema.safeParse(input);
          if (
            !parsed.success ||
            (entry.manifest.effectFor?.(parsed.data) ?? entry.manifest.effect) !== node.effect
          )
            diagnostics.push({ path: node.key, code: "workflow-native-input-invalid" });
        }
      }
      if (
        node.kind === "question" &&
        Object.values(node.input).every((value) => value.from === "literal")
      ) {
        const input = Object.fromEntries(
          Object.entries(node.input).map(([key, value]) => [
            key,
            value.from === "literal" ? value.value : null,
          ]),
        );
        const parsed = questionInputSchema.safeParse({
          ...node.request,
          ...input,
          version: 1,
          handle: { version: 1, taskId: "preview", generation: "preview" },
          presenter: { actorId: "preview", channel: "headless-user", bindingId: "preview" },
        });
        if (!parsed.success)
          diagnostics.push({ path: node.key, code: "workflow-question-input-invalid" });
      }
      if (node.kind === "agent") {
        const agent = agents.resolve(node.agentId);
        if (
          agent?.availability !== "available" ||
          !models.has(node.key) ||
          !request.delegation?.capabilities.includes("builtin:orchestration/delegate@1") ||
          node.effects.some((effect) => !request.delegation?.effects.includes(effect)) ||
          node.capabilities.some((id) => !request.delegation?.capabilities.includes(id))
        )
          diagnostics.push({ path: node.key, code: "workflow-agent-unavailable" });
      }
      if (node.kind === "model" && !models.has(node.key))
        diagnostics.push({ path: node.key, code: "workflow-model-unavailable" });
    }
    return diagnostics.slice(0, 64);
  }
  const native = async (
    capability: string,
    input: Readonly<Record<string, unknown>>,
    nodeRequest: ToolRunnerRequest,
  ) => {
    const entry = entryFor(capability);
    if (!entry)
      return {
        outcome: {
          status: "unavailable",
          effect: "none",
          reason: "workflow-capability-unavailable",
        } as const,
      };
    const parsed = entry.manifest.inputSchema.safeParse(input);
    if (!parsed.success)
      return {
        outcome: {
          status: "malformed",
          effect: "none",
          reason: "workflow-native-input-invalid",
        } as const,
      };
    let exact: Readonly<Record<string, unknown>> | undefined;
    const outcome = await invoke(
      {
        ...nodeRequest,
        capabilityId: entry.manifest.capabilityId,
        version: entry.manifest.version,
        toolName: entry.manifest.name,
        effect: entry.manifest.effectFor?.(parsed.data) ?? entry.manifest.effect,
        input: parsed.data,
        captureExactOutput: (value) => {
          exact = value;
        },
      },
      nodeRequest.taskResources ?? resources,
    );
    return { outcome, exact };
  };
  return {
    owner,
    resources,
    authority: options.authority,
    sourceGeneration: options.sourceGeneration,
    current: options.current,
    validate,
    question: options.question,
    fenced: options.fenced,
    reusable: options.reusable,
    routes: () =>
      JSON.parse(
        canonicalJson(
          Object.fromEntries(
            [...models].map(([key, binding]) => [
              key,
              { selection: binding.selection, definitionDigest: binding.definitionDigest },
            ]),
          ),
        ),
      ),
    reservation(node, record) {
      if (node.kind === "action") {
        const entry = entryFor(node.capability);
        return entry
          ? {
              ...entry.manifest.resourceAmounts,
              operations: (entry.manifest.resourceAmounts?.operations ?? 1) + 1,
            }
          : null;
      }
      if (node.kind === "model") return { operations: 2, requests: node.limits.requests ?? 1 };
      if (node.kind === "agent") {
        const agent = agents.resolve(node.agentId);
        return agent
          ? {
              ...agent.definition.limits,
              ...node.limits,
              operations: Math.min(
                node.limits.operations ?? agent.definition.limits.operations ?? 64,
                resources.remaining("operations"),
              ),
              requests: Math.min(
                node.limits.requests ?? agent.definition.limits.requests ?? 8,
                (record.limits.requests ?? 64) - (record.spent.requests ?? 0),
              ),
            }
          : null;
      }
      return { operations: 1 };
    },
    async execute(node, input, record, instance, childResources, signal) {
      if (!instance.invocation)
        return { state: "failed", effect: "none", reason: "workflow-node-not-admitted" };
      const child: ToolRunnerRequest = {
        ...request,
        signal,
        taskResources: childResources,
        invocationId: invocationId.from(instance.invocation),
        toolCallId: instance.invocation,
        input,
      };
      if (node.kind === "question")
        return options.createQuestion(node, input, record, instance, childResources, signal);
      if (node.kind === "model") {
        const model = models.get(node.key);
        return model
          ? model.execute(node, input, child)
          : { state: "failed", effect: "none", reason: "workflow-model-unavailable" };
      }
      if (node.kind === "action") {
        const entry = entryFor(node.capability);
        const parsed = entry?.manifest.inputSchema.safeParse(input);
        if (
          !entry ||
          !parsed?.success ||
          (entry.manifest.effectFor?.(parsed.data) ?? entry.manifest.effect) !== node.effect
        )
          return { state: "failed", effect: "none", reason: "workflow-native-binding-mismatch" };
        const result = await native(node.capability, input, child);
        return nodeOutcome(result.outcome, result.exact);
      }
      if (node.kind !== "agent")
        return { state: "failed", effect: "none", reason: "workflow-node-kind" };
      const binding = models.get(node.key);
      const agent = agents.resolve(node.agentId);
      if (!binding || !agent || agent.digest !== binding.definitionDigest)
        return { state: "failed", effect: "none", reason: "workflow-agent-definition-changed" };
      let result = await native(
        "builtin:orchestration/delegate@1",
        {
          operation: "launch",
          definitionId: node.agentId,
          inputJson: canonicalJson(input),
          context: [],
          capabilities: node.capabilities,
          effects: node.effects,
          limits: {
            ...node.limits,
            requests: instance.usage.requests ?? 8,
            operations: Math.max(0, (instance.usage.operations ?? 64) - 2),
          },
          model: binding.selection.route,
          required: false,
          execution: {
            version: 1,
            attachment: "foreground",
            foregroundWaitMs: 30000,
            onSettle: "notify",
            shutdown: "drain",
          },
        },
        child,
      );
      let value =
        result.exact ?? (result.outcome.status === "completed" ? result.outcome.output : null);
      const handle = value && "handle" in value ? agentHandleSchema.safeParse(value.handle) : null;
      let control = 0;
      while (
        value?.kind === "agent-running" &&
        handle?.success &&
        !signal.aborted &&
        resources.remaining("wallTimeMs") > 0
      ) {
        const waited = await native(
          "builtin:orchestration/delegate@1",
          { operation: "wait", handle: handle.data, waitMs: 30000 },
          {
            ...child,
            invocationId: invocationId.from(`${instance.invocation}-wait-${control++}`),
            toolCallId: `${instance.invocation}-wait-${control}`,
          },
        );
        if (waited.outcome.status !== "completed") return nodeOutcome(waited.outcome);
        result = await native(
          "builtin:orchestration/delegate@1",
          { operation: "result", handle: handle.data },
          {
            ...child,
            invocationId: invocationId.from(`${instance.invocation}-result-${control}`),
            toolCallId: `${instance.invocation}-result-${control}`,
          },
        );
        const candidate =
          result.exact ?? (result.outcome.status === "completed" ? result.outcome.output : null);
        if (candidate?.kind === "agent-result") value = candidate;
        else if (result.outcome.status !== "completed") return nodeOutcome(result.outcome);
      }
      const sealed = sealedAgentResultSchema.safeParse(value);
      if (!sealed.success)
        return {
          state: "uncertain",
          effect: "uncertain",
          reason: "workflow-agent-result-unavailable",
        };
      return {
        state: sealed.data.outcome,
        effect: sealed.data.effect,
        value: sealed.data.claims,
        reason: sealed.data.reason,
        observations: sealed.data.observationRefs,
        evidence: [
          {
            handle: sealed.data.handle.taskId,
            generation: String(sealed.data.handle.generation),
            source: sealed.data.resultDigest,
          },
        ],
        usage: { requests: sealed.data.providerRequests },
      };
    },
  };
}
