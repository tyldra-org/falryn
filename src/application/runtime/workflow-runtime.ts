/** Product composition: workflow state delegates effects to the ordinary native owners. */
import { z } from "zod";
import type { ArtifactStorePort } from "../../domain/artifacts/artifact.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { childProviderBindingSchema } from "../../domain/orchestration/child-admission.ts";
import type { WorkflowStore } from "../../domain/orchestration/workflow-state.ts";
import {
  type ModelSelection,
  resolveModelSelection,
} from "../../providers/configuration/model-selection.ts";
import {
  type ModelPreferences,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import type { AgentJoins } from "../orchestration/agent-joins.ts";
import type { AgentRegistry } from "../orchestration/agent-registry.ts";
import type { ProcessTaskSupervisor } from "../orchestration/process-task-supervisor.ts";
import { createWorkflowActions } from "../orchestration/workflow-actions.ts";
import { createWorkflowArtifacts } from "../orchestration/workflow-artifacts.ts";
import { createWorkflowExecution } from "../orchestration/workflow-execution.ts";
import type { WorkflowHost } from "../orchestration/workflow-host.ts";
import {
  createWorkflowNativeHost,
  type WorkflowModelBinding,
} from "../orchestration/workflow-native-host.ts";
import { createWorkflowRegistry } from "../orchestration/workflow-registry.ts";
import { bindTaskListWorkflowHost } from "../orchestration/workflow-task-list.ts";
import type { ProductAgentRuntimePorts } from "./product-agent-runtime.ts";
import {
  executeWorkflowModel,
  type WorkflowProvider,
  workflowProviderBinding,
} from "./workflow-model-runtime.ts";

const selectionSchema = z.strictObject({
  kind: z.literal("route"),
  route: roleRouteBaseSchema,
  source: z.string().min(1).max(256),
  chain: z
    .array(z.strictObject({ source: z.string().min(1).max(256), route: roleRouteBaseSchema }))
    .max(32),
  policyRevision: z.int().nonnegative(),
  configurationGeneration: z.int().nonnegative(),
  definitions: z
    .array(
      z.strictObject({
        id: z.string().max(256),
        revision: z.string().max(256),
        schemaRevision: z.int().nonnegative(),
      }),
    )
    .max(256),
  availability: z.enum(["available", "disabled", "unavailable", "incompatible"]),
  reason: z.string().nullable(),
});
const capturedSchema = z.strictObject({
  selection: selectionSchema,
  definitionDigest: z.string().nullable(),
  binding: childProviderBindingSchema,
});
export type WorkflowRuntimeOptions = {
  readonly store: WorkflowStore;
  readonly tasks: ProcessTaskSupervisor;
  readonly joins: AgentJoins;
  readonly agents: AgentRegistry;
  readonly artifacts: ArtifactStorePort;
  readonly preferences: () => ModelPreferences;
  readonly provider: (profile: string, signal: AbortSignal) => Promise<WorkflowProvider | null>;
  /** Presenter capabilities stay with the admitted host's structured-question owner. */
  readonly questions?: {
    create: WorkflowHost["execute"];
    inspect: WorkflowHost["question"];
    wait: NonNullable<WorkflowHost["wait"]>;
  };
  readonly reusable?: WorkflowHost["reusable"];
  readonly taskLists?: Parameters<typeof bindTaskListWorkflowHost>[1];
};
export function composeWorkflowRuntime(
  ports: ProductAgentRuntimePorts,
  options: WorkflowRuntimeOptions,
) {
  const artifacts = createWorkflowArtifacts(options.artifacts);
  const questions = options.questions;
  const execution = createWorkflowExecution({
    store: options.store,
    artifacts,
    clock: ports.clock,
  });
  return createWorkflowActions({
    execution,
    store: options.store,
    tasks: options.tasks,
    now: () => Number(ports.clock.now()),
    async prepare(definition, request, record, overrides) {
      const registry = ports.toolRegistry;
      const initiating = request.delegation;
      if (
        !registry ||
        !request.taskResources ||
        !request.processTask ||
        !initiating ||
        !request.invokeCapability
      )
        return null;
      if (
        overrides?.steps &&
        Object.keys(overrides.steps).some(
          (key) =>
            !definition.nodes.some(
              (node) => node.key === key && (node.kind === "model" || node.kind === "agent"),
            ),
        )
      )
        return null;
      const resources = request.taskResources.subdivide({
        ...(record?.limits ?? definition.limits),
        wallTimeMs: Math.max(
          0,
          (record?.deadline ?? request.taskResources.expiresAt) - Number(ports.clock.now()),
        ),
      });
      if (!resources) return null;
      let prepared = false;
      try {
        const owner = request.processTask.owner;
        const identity = {
          id: definition.id,
          provenance: "user" as const,
          availability: "available" as const,
          unavailableReason: null,
        };
        const definitions = createWorkflowRegistry();
        const registered = definitions.register({ identity, definition }, null);
        if (!registered.ok) {
          resources.close();
          return null;
        }
        const models = new Map<string, WorkflowModelBinding>();
        const routes: Record<string, z.infer<typeof capturedSchema>> = {};
        for (const node of definition.nodes) {
          if (node.kind !== "agent" && node.kind !== "model") continue;
          const saved = record ? capturedSchema.safeParse(record.routes[node.key]) : null;
          const selected: ModelSelection | { kind: "no-model" } = saved?.success
            ? saved.data.selection
            : resolveModelSelection({
                preferences: options.preferences(),
                main: initiating.route,
                configurationGeneration: owner.configurationGeneration,
                definitions: [...options.agents.models(), ...definitions.models()],
                target: { kind: "step", id: definition.id, key: node.key },
                ...(overrides?.model ? { workflowRunDefault: overrides.model } : {}),
                ...(overrides?.steps?.[node.key]
                  ? { authorizedOverride: overrides.steps[node.key] }
                  : {}),
              });
          if (
            (record && !saved?.success) ||
            selected.kind !== "route" ||
            selected.availability !== "available"
          )
            continue;
          const provider = await options.provider(selected.route.providerProfileId, request.signal);
          const binding = provider ? workflowProviderBinding(selected, provider) : null;
          if (
            !provider ||
            !binding ||
            (saved?.success && canonicalDigest(saved.data.binding) !== canonicalDigest(binding))
          )
            continue;
          const agent = node.kind === "agent" ? options.agents.resolve(node.agentId) : null;
          if (
            node.kind === "agent" &&
            (!agent || (saved?.success && agent.digest !== saved.data.definitionDigest))
          )
            continue;
          routes[node.key] = capturedSchema.parse({
            selection: selected,
            definitionDigest: agent?.digest ?? null,
            binding,
          });
          models.set(node.key, {
            selection: selected,
            definitionDigest: agent?.digest ?? null,
            execute: (node, input, child) =>
              executeWorkflowModel({
                ports,
                artifacts: options.artifacts,
                provider,
                selection: selected,
                binding,
                node,
                input,
                request: child,
                resources: child.taskResources ?? resources,
              }),
          });
        }
        const nativeHost = createWorkflowNativeHost({
          request: { ...request, taskResources: resources },
          registry,
          agents: options.agents,
          models,
          taskListOwner: options.taskLists !== undefined,
          authority: canonicalDigest({
            workspace: owner.workspaceId,
            session: owner.sessionId,
            effects: initiating.effects,
            capabilities: [...initiating.capabilities].sort(),
          }),
          sourceGeneration:
            record?.sourceGeneration ??
            canonicalDigest({ workspace: owner.workspaceId, configuration: registry.generation }),
          current: (current) =>
            current.owner.workspaceId === owner.workspaceId &&
            current.owner.sessionId === owner.sessionId &&
            current.owner.configurationGeneration === owner.configurationGeneration,
          createQuestion: questions
            ? (node, input, record, instance, _childResources, signal) =>
                questions.create(node, input, record, instance, resources, signal)
            : async () => ({
                state: "failed",
                effect: "none",
                reason: "workflow-question-owner-unavailable",
              }),
          question:
            questions?.inspect ??
            (async () => ({
              state: "waiting",
              effect: "none",
              reason: "workflow-question-owner-unavailable",
            })),
          async fenced(task) {
            if (!task) return false;
            const result = options.joins.task(task);
            return (
              result.ok &&
              result.value.state === "terminal" &&
              (["supervisor-vanished", "supervisor-replaced"].includes(
                result.value.terminal.reason,
              ) ||
                result.value.terminal.effect !== "uncertain")
            );
          },
          reusable:
            options.reusable ??
            (async (node) =>
              node.kind === "condition" || node.kind === "join" || node.kind === "model"),
        });
        if (!nativeHost) {
          resources.close();
          return null;
        }
        const host = options.taskLists
          ? bindTaskListWorkflowHost(nativeHost, options.taskLists)
          : nativeHost;
        prepared = true;
        return {
          ...host,
          routes: () => JSON.parse(JSON.stringify(routes)),
          validate: (graph) => [
            ...host.validate(graph),
            ...(!questions
              ? graph.nodes
                  .filter((node) => node.kind === "question")
                  .map((node) => ({ path: node.key, code: "workflow-question-owner-unavailable" }))
              : []),
          ],
          ...(questions && !definition.taskList ? { wait: questions.wait } : {}),
        };
      } catch {
        return null;
      } finally {
        if (!prepared) resources.close();
      }
    },
  });
}
