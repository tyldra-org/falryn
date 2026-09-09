/** Definition selection and retained child generations over the shared task/admission owners. */
import { randomUUID } from "node:crypto";
import {
  bytesDigest,
  canonicalDigest,
  canonicalJson,
  freezeMetadata,
  parseMetadata,
} from "../../domain/extensions/canonical.ts";
import { type ClockPort, scopeId } from "../../domain/foundation/index.ts";
import type {
  ChildAuthority,
  ChildProviderBinding,
} from "../../domain/orchestration/child-admission.ts";
import type { EffectCertainty } from "../../domain/orchestration/outcome.ts";
import {
  MAX_RETAINED_PROCESS_TASKS,
  type ProcessTaskHandle,
  processTaskControlSchema,
} from "../../domain/orchestration/process-task.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import {
  type ModelSelection,
  resolveModelSelection,
} from "../../providers/configuration/model-selection.ts";
import type { ModelPreferences } from "../../providers/configuration/policy-schema.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import {
  type AgentContextItem,
  MAX_AGENT_CONTEXT_BYTES,
  MAX_AGENT_RESULT_BYTES,
  MAX_AGENT_STEERING_BYTES,
  type RegisteredAgent,
  validateAgentValue,
} from "./agent-definition.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { type AdmittedChild, createChildAdmission } from "./child-admission.ts";
import {
  type AgentHandle,
  type AgentLaunch,
  delegationCommandSchema,
  type SealedAgentResult,
  sealedAgentResultSchema,
} from "./delegation-contract.ts";
import type { ProcessTaskSupervisor } from "./process-task-supervisor.ts";
import { createScopeTree } from "./scope-tree.ts";

export type PreparedAgent = {
  readonly definition: RegisteredAgent;
  readonly selection: ModelSelection;
  readonly authority: ChildAuthority;
  readonly context: readonly AgentContextItem[];
  readonly omitted: readonly { id: string; reason: string }[];
  readonly digest: string;
};
export type AgentExecution = {
  readonly response: string;
  readonly outcome: SealedAgentResult["outcome"];
  readonly effect: EffectCertainty;
  readonly reason: string;
  readonly observationRefs: readonly string[];
  readonly providerRequests: number;
  readonly usage: unknown;
};
export type AgentRun = {
  readonly handle: AgentHandle;
  readonly rootTaskId: string;
  readonly parentTaskId: string;
  readonly prepared: PreparedAgent;
  readonly admission: AdmittedChild;
  readonly input: unknown;
  readonly previous: SealedAgentResult | null;
  readonly signal: AbortSignal;
  takeSteering(): readonly { id: string; text: string }[];
};
export type DelegationOptions = {
  readonly registry: AgentRegistry;
  readonly clock: ClockPort;
  readonly tasks: ProcessTaskSupervisor;
  preferences(): ModelPreferences;
  configurationGeneration(): number;
  /** Native capability owner includes readiness and selected non-tool instruction content. */
  capability(id: string): {
    readonly ready: boolean;
    readonly reason: string;
    readonly instruction?: AgentContextItem;
  };
  validateContext?(
    context: readonly AgentContextItem[],
    request: ToolRunnerRequest,
  ): Promise<boolean>;
  bindModel(
    selection: ModelSelection,
    parent: ToolRunnerRequest,
    capabilities: readonly string[],
  ):
    | ChildProviderBinding
    | { readonly reason: string }
    | Promise<ChildProviderBinding | { readonly reason: string }>;
  execute(run: AgentRun): Promise<AgentExecution>;
};
type Steering = { id: string; text: string; state: "queued" | "admitted" | "missed-terminal" };
type Retained = {
  handle: AgentHandle;
  readonly rootTaskId: string;
  readonly parentTaskId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly workspaceId: string;
  readonly prepared: PreparedAgent;
  readonly admission: AdmittedChild;
  readonly launch: AgentLaunch;
  readonly release: () => void;
  readonly expires: ReturnType<typeof setTimeout>;
  running: boolean;
  result: SealedAgentResult | null;
  readonly history: Map<number, SealedAgentResult>;
  steering: Steering[];
  readonly workDigests: Set<string>;
};
const refused = (reason: string): ToolInvocationOutcome => ({
  status: "unavailable",
  reason,
  effect: "none",
});
const completed = (
  output: Readonly<Record<string, unknown>>,
  _effect: EffectCertainty = "none",
): ToolInvocationOutcome => ({ status: "completed", output, effect: "completed" });

export function createDelegation(options: DelegationOptions) {
  const retained = new Map<string, Retained>();
  const roots = new WeakMap<object, ReturnType<typeof createScopeTree>>();

  async function prepare(
    launch: AgentLaunch,
    request: ToolRunnerRequest,
    parent?: AgentRun,
  ): Promise<PreparedAgent | { reason: string }> {
    const definition = options.registry.resolve(launch.definitionId);
    if (definition === null) return { reason: "agent-definition-not-found" };
    if (definition.availability !== "available")
      return { reason: definition.reason ?? "agent-definition-disabled" };
    if (!request.delegation || !request.processTask || !request.taskResources)
      return { reason: "agent-parent-unavailable" };
    if (parent && !parent.prepared.definition.definition.nestedDelegation)
      return { reason: "agent-nesting-denied" };
    if (options.configurationGeneration() !== request.processTask.owner.configurationGeneration)
      return { reason: "agent-stale-generation" };
    const selection = resolveModelSelection({
      preferences: options.preferences(),
      main: request.delegation.route,
      configurationGeneration: options.configurationGeneration(),
      definitions: options.registry.models(),
      target: { kind: "agent", id: definition.id },
      ...(launch.model === undefined ? {} : { authorizedOverride: launch.model }),
    });
    if (selection.kind !== "route" || selection.availability !== "available")
      return { reason: "agent-model-unavailable" };
    const allowed = new Set(request.delegation.capabilities);
    const selected = [
      ...new Set([...launch.capabilities, ...definition.definition.capabilities.required]),
    ];
    const context = [...launch.context];
    const omitted: { id: string; reason: string }[] = [];
    for (const id of [...selected, ...definition.definition.capabilities.optional]) {
      const capability = options.capability(id);
      const required = selected.includes(id);
      if (!capability.ready || !allowed.has(id)) {
        if (required)
          return { reason: !allowed.has(id) ? "agent-capability-denied" : capability.reason };
        omitted.push({ id, reason: capability.reason });
        continue;
      }
      if (!selected.includes(id)) selected.push(id);
      if (capability.instruction) context.push(capability.instruction);
    }
    const binding = await options.bindModel(selection, request, selected);
    if ("reason" in binding) return binding;
    if (
      context.length > 64 ||
      context.some((item) => bytesDigest(item.text) !== item.digest) ||
      Buffer.byteLength(canonicalJson(context)) > MAX_AGENT_CONTEXT_BYTES
    )
      return { reason: "agent-context-invalid" };
    if (
      context.some((item) => item.artifact !== undefined) &&
      (!options.validateContext || !(await options.validateContext(context, request)))
    )
      return { reason: "agent-artifact-unavailable-or-corrupt" };
    const authority: ChildAuthority = {
      version: 1,
      workspaceId: request.processTask.owner.workspaceId,
      configurationGeneration: String(options.configurationGeneration()),
      capabilityGeneration: String(options.configurationGeneration()),
      providers: [binding],
      capabilities: selected,
      effects: launch.effects.filter(
        (effect) =>
          request.delegation?.effects.includes(effect) &&
          definition.definition.effects.includes(effect),
      ),
    };
    const prepared = { definition, selection, authority, context, omitted };
    if (
      Buffer.byteLength(
        canonicalJson({
          authority,
          context: context.map(({ text: _text, ...reference }) => reference),
          omitted,
          route: selection.route,
        }),
      ) >
      24 * 1024
    )
      return { reason: "agent-preparation-limit" };
    if (
      options.configurationGeneration() !== selection.configurationGeneration ||
      options.registry.resolve(definition.id)?.digest !== definition.digest ||
      options.registry.resolve(definition.id)?.availability !== "available"
    )
      return { reason: "agent-stale-generation" };
    return freezeMetadata({ ...prepared, digest: canonicalDigest(prepared) });
  }

  function close(entry: Retained) {
    clearTimeout(entry.expires);
    entry.admission.close();
    entry.release();
    retained.delete(entry.handle.taskId);
  }

  async function run(
    entry: Retained,
    request: ToolRunnerRequest,
    input: unknown,
    context: readonly AgentContextItem[],
  ): Promise<ToolInvocationOutcome> {
    const prepared = { ...entry.prepared, context };
    const preparation = {
      route: prepared.selection.route,
      source: prepared.selection.source,
      execution: prepared.authority,
      context: prepared.context.map(({ text: _text, ...reference }) => reference),
      omitted: prepared.omitted,
    };
    const first = Promise.withResolvers<ToolInvocationOutcome>();
    const owner = request.processTask?.owner;
    if (!owner) return refused("agent-parent-unavailable");
    const taskRequest: ToolRunnerRequest = {
      ...request,
      signal: entry.admission.scope.signal,
      processTask: {
        owner,
        finished: Promise.resolve(),
        deadline: entry.admission.resources.expiresAt,
        publishReceipt(value) {
          first.resolve(
            completed({
              kind: "agent-running",
              handle: entry.handle,
              task: value.status === "completed" ? value.output : null,
              preparation,
              preparationDigest: canonicalDigest(prepared),
            }),
          );
          return true;
        },
      },
    };
    const running = options.tasks.run({
      executionKind: "agent",
      request: taskRequest,
      execution: entry.launch.execution,
      timeoutMs: Math.max(1, entry.admission.resources.expiresAt - Number(options.clock.now())),
      outputMode: "raw",
      onAdmitted(task: ProcessTaskHandle) {
        entry.handle = { ...entry.handle, task };
      },
      async run(_ownership, signal) {
        let execution: AgentExecution;
        try {
          execution = await options.execute({
            handle: entry.handle,
            rootTaskId: entry.rootTaskId,
            parentTaskId: entry.parentTaskId,
            prepared,
            admission: entry.admission,
            input,
            previous: entry.result,
            signal,
            takeSteering() {
              const queued = entry.steering.filter((value) => value.state === "queued");
              for (const value of queued) value.state = "admitted";
              return queued.map(({ id, text }) => ({ id, text }));
            },
          });
        } catch {
          execution = {
            response: "",
            outcome: "uncertain",
            effect: "uncertain",
            reason: "agent-execution-interrupted",
            observationRefs: [],
            providerRequests: 0,
            usage: null,
          };
        }
        const responseTooLarge = Buffer.byteLength(execution.response) > MAX_AGENT_RESULT_BYTES / 2;
        let claims: unknown = null;
        try {
          if (!responseTooLarge) claims = parseMetadata(execution.response);
        } catch {
          /* Report invalid structured output below. */
        }
        const valid = validateAgentValue(
          entry.prepared.definition.definition.resultSchema,
          claims,
          MAX_AGENT_RESULT_BYTES / 2,
        );
        for (const steering of entry.steering)
          if (steering.state === "queued") steering.state = "missed-terminal";
        const facts = {
          version: 1 as const,
          kind: "agent-result" as const,
          handle: entry.handle,
          parent: {
            sessionId: entry.parentSessionId,
            turnId: entry.parentTurnId,
            taskId: entry.parentTaskId,
          },
          rootTaskId: entry.rootTaskId,
          definitionId: entry.prepared.definition.id,
          definitionDigest: entry.prepared.definition.digest,
          preparationDigest: canonicalDigest(prepared),
          preparation,
          previousResultDigest: entry.result?.resultDigest ?? null,
          outcome:
            !valid && execution.outcome === "completed" ? ("failed" as const) : execution.outcome,
          effect: execution.effect,
          claims: valid ? claims : null,
          reason:
            valid || execution.outcome !== "completed"
              ? execution.reason
              : responseTooLarge
                ? "agent-result-limit"
                : "agent-result-schema-invalid",
          parentVerification: "not-asserted" as const,
          observationRefs: execution.observationRefs,
          omittedObservationRefs: 0,
          providerRequests: execution.providerRequests,
          usage: execution.usage,
          steering: entry.steering.map(({ id, state }) => ({ id, state })),
        };
        let parsed = sealedAgentResultSchema.safeParse({
          ...facts,
          resultDigest: canonicalDigest(facts),
        });
        if (
          !parsed.success ||
          Buffer.byteLength(canonicalJson(parsed.data)) > MAX_AGENT_RESULT_BYTES
        ) {
          const bounded = {
            ...facts,
            outcome: execution.outcome === "completed" ? ("failed" as const) : execution.outcome,
            claims: null,
            reason: "agent-result-limit",
            usage: null,
            observationRefs: execution.observationRefs.slice(0, 64),
            omittedObservationRefs: Math.max(0, execution.observationRefs.length - 64),
          };
          parsed = sealedAgentResultSchema.safeParse({
            ...bounded,
            resultDigest: canonicalDigest(bounded),
          });
        }
        if (!parsed.success)
          return {
            outcome: {
              status: "uncertain",
              effect: "uncertain",
              recoveryHint: "invalid-agent-execution-facts",
            },
            capture: null,
          };
        const result = freezeMetadata(parsed.data);
        return {
          outcome: completed(result),
          capture: null,
          agentTerminal: { outcome: result.outcome, effect: result.effect },
        };
      },
    });
    void running.then(
      (value) => {
        entry.running = false;
        const sealed =
          value.status === "completed" ? sealedAgentResultSchema.safeParse(value.output) : null;
        if (sealed?.success) {
          entry.result = freezeMetadata(sealed.data);
          entry.history.set(entry.handle.generation, entry.result);
        }
        first.resolve(value);
      },
      () => {
        entry.running = false;
        first.resolve({
          status: "uncertain",
          effect: "uncertain",
          recoveryHint: "agent-settlement-unavailable",
        });
      },
    );
    return first.promise;
  }

  async function execute(
    raw: unknown,
    request: ToolRunnerRequest,
    parent?: AgentRun,
  ): Promise<ToolInvocationOutcome> {
    const parsed = delegationCommandSchema.safeParse(raw);
    if (!parsed.success) return refused("invalid-delegation-command");
    const command = parsed.data;
    if (command.operation === "list") {
      const page = options.registry.page(command.search, command.offset);
      return completed({
        ...page,
        entries: page.entries.map(({ id, digest, definition, availability, reason }) => ({
          id,
          digest,
          label: definition.label,
          purpose: definition.purpose.slice(0, 256),
          availability,
          reason,
          preset: definition.preset ?? "default",
        })),
      });
    }
    if (command.operation === "definition") {
      const definition = options.registry.resolve(command.definitionId);
      return definition ? completed({ definition }) : refused("agent-definition-not-found");
    }
    if (command.operation === "resolve") {
      const owner = request.processTask?.owner;
      const matches = [...retained.values()].filter(
        (entry) =>
          entry.launch.name === command.name &&
          entry.parentSessionId === owner?.sessionId &&
          entry.workspaceId === owner.workspaceId,
      );
      return matches.length === 1 && matches[0]
        ? completed({ handle: matches[0].handle })
        : refused(matches.length > 1 ? "agent-name-ambiguous" : "agent-name-not-found");
    }
    if (request.signal.aborted) return { status: "cancelled", effect: "none" };
    if (command.operation === "launch") {
      if (retained.size >= MAX_RETAINED_PROCESS_TASKS) return refused("agent-retention-capacity");
      const prepared = await prepare(command, request, parent);
      if ("reason" in prepared) return refused(prepared.reason);
      if (retained.size >= MAX_RETAINED_PROCESS_TASKS) return refused("agent-retention-capacity");
      let input: unknown;
      try {
        input = parseMetadata(command.inputJson);
      } catch {
        return refused("agent-input-invalid");
      }
      if (
        !validateAgentValue(
          prepared.definition.definition.inputSchema,
          input,
          MAX_AGENT_CONTEXT_BYTES,
        )
      )
        return refused("agent-input-invalid");
      const resources = request.taskResources;
      const owner = request.processTask?.owner;
      if (!resources || !owner) return refused("agent-parent-unavailable");
      let tree = roots.get(resources);
      if (!tree && !parent) {
        tree = createScopeTree({
          clock: options.clock,
          rootScopeId: scopeId.from(`delegation-${resources.id}`),
        });
        roots.set(resources, tree);
      }
      const root = tree
        ? createChildAdmission({
            resources,
            tree,
            scope: tree.root(),
            authority: {
              ...prepared.authority,
              capabilities: [...(request.delegation?.capabilities ?? [])],
              effects: [...(request.delegation?.effects ?? [])],
            },
          })
        : undefined;
      const id = `agent-${randomUUID()}`;
      const workDigest = canonicalDigest({ input, context: prepared.context }).slice(7);
      const limits = { ...command.limits };
      for (const [key, ceiling] of Object.entries(prepared.definition.definition.limits)) {
        const resource = key as keyof typeof limits;
        if (ceiling !== undefined)
          limits[resource] = Math.min(limits[resource] ?? ceiling, ceiling);
      }
      const admitted = (parent?.admission ?? root)?.admit({
        id,
        workDigest,
        authority: prepared.authority,
        limits,
      });
      if (!admitted || admitted.kind === "refused")
        return refused(`agent-${admitted?.reason ?? "parent-unavailable"}`);
      const release = admitted.child.resources.retain();
      if (!release) {
        admitted.child.close();
        return refused("agent-parent-closed");
      }
      const entry: Retained = {
        handle: { taskId: id, generation: 1 },
        rootTaskId: parent?.rootTaskId ?? resources.id,
        parentTaskId: parent?.handle.taskId ?? resources.id,
        parentSessionId: owner.sessionId,
        parentTurnId: owner.turnId,
        workspaceId: owner.workspaceId,
        prepared,
        admission: admitted.child,
        launch: command,
        release,
        expires: setTimeout(
          () => close(entry),
          Math.max(1, admitted.child.resources.expiresAt - Number(options.clock.now())),
        ),
        running: true,
        result: null,
        history: new Map(),
        steering: [],
        workDigests: new Set([workDigest]),
      };
      entry.expires.unref?.();
      retained.set(id, entry);
      return run(entry, request, input, prepared.context);
    }
    const entry = retained.get(command.handle.taskId);
    if (!entry) {
      if (
        command.handle.task &&
        ["inspect", "result", "wait", "cancel", "detach", "reattach", "cleanup"].includes(
          command.operation,
        )
      ) {
        const { handle: _handle, ...control } = command;
        return options.tasks.control(
          request,
          processTaskControlSchema.parse({
            ...control,
            ...command.handle.task,
          }),
        );
      }
      return refused("agent-retained-context-unavailable");
    }
    if (
      request.processTask?.owner.sessionId !== entry.parentSessionId ||
      request.processTask.owner.workspaceId !== entry.workspaceId
    )
      return refused("agent-foreign-parent");
    if (command.handle.generation !== entry.handle.generation) {
      const previous = entry.history.get(command.handle.generation);
      return command.operation === "result" && previous
        ? completed(previous)
        : refused("agent-stale-generation");
    }
    if (
      command.operation === "result" &&
      entry.result?.handle.generation === entry.handle.generation &&
      !entry.running
    )
      return completed(entry.result, entry.result.effect);
    if (command.operation === "steer") {
      if (!entry.running) return completed({ kind: "agent-steering", state: "missed-terminal" });
      if (
        entry.steering.length >= 64 ||
        Buffer.byteLength(command.text) +
          entry.steering.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) >
          MAX_AGENT_STEERING_BYTES
      )
        return refused("agent-steering-capacity");
      const id = `steer-${randomUUID()}`;
      entry.steering.push({ id, text: command.text, state: "queued" });
      return completed({ kind: "agent-steering", id, state: "queued" });
    }
    if (command.operation === "continue") {
      if (entry.running) return refused("agent-generation-running");
      if (
        entry.admission.resources.remaining("wallTimeMs") === 0 ||
        entry.admission.scope.signal.aborted
      )
        return refused("agent-expired");
      if (entry.handle.generation >= 64) return refused("agent-generation-limit");
      if (
        options.registry.resolve(entry.prepared.definition.id)?.digest !==
          entry.prepared.definition.digest ||
        options.configurationGeneration() !== entry.prepared.selection.configurationGeneration
      )
        return refused("agent-stale-definition-or-configuration");
      const checked = await prepare(
        { ...entry.launch, inputJson: command.inputJson, context: command.context },
        request,
        parent,
      );
      if (
        "reason" in checked ||
        canonicalDigest(checked.selection.route) !==
          canonicalDigest(entry.prepared.selection.route) ||
        canonicalDigest(checked.authority) !== canonicalDigest(entry.prepared.authority)
      )
        return refused("agent-continuation-route-or-capability-changed");
      // Preparation may read artifacts. Recheck after yielding before claiming the next generation.
      if (entry.running || command.handle.generation !== entry.handle.generation)
        return refused("agent-generation-running");
      let input: unknown;
      try {
        input = parseMetadata(command.inputJson);
      } catch {
        return refused("agent-input-invalid");
      }
      if (
        !validateAgentValue(
          entry.prepared.definition.definition.inputSchema,
          input,
          MAX_AGENT_CONTEXT_BYTES,
        )
      )
        return refused("agent-input-invalid");
      const workDigest = canonicalDigest({ input, context: checked.context }).slice(7);
      if (entry.workDigests.has(workDigest)) return refused("agent-no-progress");
      entry.workDigests.add(workDigest);
      entry.handle = { taskId: entry.handle.taskId, generation: entry.handle.generation + 1 };
      entry.running = true;
      entry.steering = [];
      return run(entry, request, input, checked.context);
    }
    if (!entry.handle.task) return refused("agent-task-not-admitted");
    const { handle: _handle, ...control } = command;
    const result = await options.tasks.control(
      request,
      processTaskControlSchema.parse({
        ...control,
        ...entry.handle.task,
      }),
    );
    if (command.operation === "cleanup" && result.status === "completed") close(entry);
    return result;
  }
  const unsubscribe = options.tasks.onInterrupt(() => {
    for (const entry of retained.values()) close(entry);
  });
  return {
    execute,
    close() {
      unsubscribe();
      for (const entry of retained.values()) close(entry);
    },
    report: () => ({ retained: retained.size }),
  };
}
export type Delegation = ReturnType<typeof createDelegation>;
