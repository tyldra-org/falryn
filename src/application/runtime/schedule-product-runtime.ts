/** Scheduled targets re-enter the same gateway and workflow action owner as live work. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { artifactId, contentDigest } from "../../domain/artifacts/index.ts";
import { canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import {
  capabilityId,
  invocationId,
  sessionId,
  streamId,
  traceId,
  turnId,
} from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  type ProcessTaskSnapshot,
  processTaskReceiptSchema,
} from "../../domain/orchestration/process-task.ts";
import type { ProcessTaskStore } from "../../domain/orchestration/process-task-store.ts";
import type {
  ScheduleRecord,
  ScheduleResult,
  ScheduleStore,
  ScheduleTerminal,
} from "../../domain/orchestration/schedule-state.ts";
import {
  decodeWorkflowDefinition,
  validWorkflowArguments,
} from "../../domain/orchestration/workflow-definition.ts";
import type { WorkflowRecord, WorkflowStore } from "../../domain/orchestration/workflow-state.ts";
import type {
  ProcessBirthIdentity,
  ProcessIdentityPort,
} from "../../domain/process/process-identity.ts";
import { createToolHookRegistry, type ToolInvocationOutcome } from "../../domain/tools/index.ts";
import type { ModelPreferences } from "../../providers/configuration/policy-schema.ts";
import { processProductResources } from "../orchestration/product-resources.ts";
import { createScheduleActions } from "../orchestration/schedule-actions.ts";
import { createScheduleRuntime, type ScheduleExecutor } from "../orchestration/schedule-runtime.ts";
import type { WorkflowActions } from "../orchestration/workflow-actions.ts";
import { createWorkflowRegistry } from "../orchestration/workflow-registry.ts";
import { createProductToolGateway } from "../tools/product-tool-gateway.ts";
import { mergeProductToolBundles, type ProductToolBundle } from "../tools/product-tools-merge.ts";
import { composeWorkflowTool } from "../tools/workflow-tool.ts";
import type { ProductAgentRuntimePorts } from "./product-agent-runtime.ts";
import { createTurnEventJournal } from "./turn-event-journal.ts";

export type ProductSchedulePorts = {
  defaults?(): import("../../domain/orchestration/schedule-defaults.ts").ScheduleDefaults;
  store: ScheduleStore;
  tasks: ProcessTaskStore;
  process: ProcessBirthIdentity | null;
  identities: ProcessIdentityPort;
  timezoneData: string;
  current(record: ScheduleRecord, signal: AbortSignal): Promise<ScheduleResult<string>>;
  notify: ScheduleExecutor["notify"];
  retain(owner: { close(): Promise<boolean> }): () => void;
  autostart?: boolean;
};
function settledTask(task: ProcessTaskSnapshot, at: number): ScheduleTerminal | null {
  if (task.state !== "terminal") return null;
  return {
    status: task.terminal.outcome === "completed" ? "succeeded" : task.terminal.outcome,
    effect: task.terminal.effect,
    reason: `task-${task.terminal.reason}`,
    result: task.terminal.result,
    at,
  };
}
function settledWorkflow(record: WorkflowRecord, at: number): ScheduleTerminal | null {
  const state = record.state;
  if (!["completed", "failed", "cancelled", "timed-out", "uncertain"].includes(state)) return null;
  return {
    status:
      state === "completed"
        ? "succeeded"
        : state === "failed" || state === "cancelled" || state === "timed-out"
          ? state
          : "uncertain",
    effect:
      state === "uncertain" || record.nodes.some((node) => node.effect === "uncertain")
        ? "uncertain"
        : record.nodes.some((node) => node.effect === "partial")
          ? "partial"
          : record.nodes.some((node) => node.effect === "completed")
            ? state === "completed"
              ? "completed"
              : "partial"
            : "none",
    reason: `workflow-${state}`,
    result: record.output,
    at,
  };
}
export function composeScheduleProductRuntime(
  ports: ProductAgentRuntimePorts,
  options: {
    schedules: ProductSchedulePorts;
    tools: ProductToolBundle;
    workflows: WorkflowActions | null;
    workflowStore?: WorkflowStore;
    preferences(): ModelPreferences;
  },
) {
  const { schedules } = options;
  const workspace = String(ports.correlation.workspaceId);
  const resources = ports.resources ?? processProductResources;
  const now = () => Number(ports.clock.now());
  const bundle = options.workflows
    ? mergeProductToolBundles(ports.correlation.configurationGeneration, [
        options.tools,
        composeWorkflowTool(ports.correlation.configurationGeneration, options.workflows),
      ])
    : options.tools;
  const idsFor = (record: ScheduleRecord) =>
    record.definition.target.kind === "action"
      ? [record.definition.target.capability]
      : [
          ...new Set(
            record.definition.target.definition.nodes.flatMap((node) =>
              node.kind === "action"
                ? [node.capability]
                : node.kind === "agent"
                  ? ["builtin:orchestration/delegate@1", ...node.capabilities]
                  : [],
            ),
          ),
        ];
  async function validate(record: ScheduleRecord, signal: AbortSignal) {
    if (record.workspace !== workspace || signal.aborted)
      return err({ code: "workspace-unavailable" });
    const configuration = await schedules.current(record, signal);
    if (!configuration.ok) return configuration;
    if (!schedules.process) return err({ code: "schedule-host-unavailable" });
    if (record.definition.target.kind === "workflow" && !options.workflows)
      return err({ code: "workflow-owner-unavailable" });
    if (
      record.definition.target.kind === "workflow" &&
      (!decodeWorkflowDefinition(record.definition.target.definition).ok ||
        !validWorkflowArguments(
          record.definition.target.definition,
          record.definition.target.arguments,
        ))
    )
      return err({ code: "workflow-input-invalid" });
    if (
      record.definition.target.kind === "workflow" &&
      !createWorkflowRegistry().register(
        {
          identity: {
            id: record.definition.target.definition.id,
            provenance: "user",
            availability: "available",
            unavailableReason: null,
          },
          definition: record.definition.target.definition,
        },
        null,
      ).ok
    )
      return err({ code: "workflow-registration-invalid" });
    const targets = [];
    for (const id of idsFor(record)) {
      if (["builtin:orchestration/schedule@1", "builtin:orchestration/workflow@1"].includes(id))
        return err({ code: "recursive-schedule-target" });
      const entry = bundle.registry.resolveByCapabilityId(capabilityId.from(id));
      const capability = bundle.capabilityRegistry.resolveById(capabilityId.from(id));
      if (
        !entry ||
        bundle.runner.hasBinding?.(entry.manifest.capabilityId) !== true ||
        !capability?.state.executable
      )
        return err({ code: "target-unavailable" });
      if (
        record.definition.target.kind === "action" &&
        !entry.manifest.inputSchema.safeParse(record.definition.target.input).success
      )
        return err({ code: "target-input-invalid" });
      const source = record.source;
      if (source.kind === "package") {
        const effects =
          record.definition.target.kind === "action"
            ? [entry.manifest.effectFor?.(record.definition.target.input) ?? entry.manifest.effect]
            : record.definition.target.definition.nodes.flatMap((node) =>
                node.kind === "action" && node.capability === id
                  ? [node.effect]
                  : node.kind === "agent"
                    ? [...node.effects]
                    : [],
              );
        if (effects.some((effect) => !source.effects.includes(effect)))
          return err({ code: "package-schedule-effect-denied" });
      }
      targets.push({
        id,
        input: z.toJSONSchema(entry.manifest.inputSchema),
        output: z.toJSONSchema(entry.manifest.outputSchema),
        effect: entry.manifest.effect,
        trust: capability.trust,
        schemas: capability.schemas,
      });
    }
    if (
      record.definition.target.kind === "workflow" &&
      record.definition.target.definition.nodes.some(
        (node) => node.kind === "model" || node.kind === "agent",
      ) &&
      !options.preferences().roles.default
    )
      return err({ code: "model-route-unavailable" });
    return ok({
      descriptor: canonicalDigest(
        JSON.parse(JSON.stringify({ targets, target: record.definition.target })),
      ),
      authority: canonicalDigest({
        workspace,
        configuration: configuration.value,
        source: record.source,
        target: record.digest,
      }),
      configuration: configuration.value,
      configurationGeneration: Number(ports.correlation.configurationGeneration),
      timezoneData: schedules.timezoneData,
    });
  }
  const executor: ScheduleExecutor = {
    validate,
    async execute(record, attempt, signal, link) {
      const at = () => now();
      const terminal = (
        status: ScheduleTerminal["status"],
        effect: ScheduleTerminal["effect"],
        reason: string,
        result: ScheduleTerminal["result"] = null,
      ): ScheduleTerminal => ({ status, effect, reason, result, at: at() });
      const hooks =
        ports.toolHooks ?? createToolHookRegistry(ports.correlation.configurationGeneration, []);
      const hookRegistry = "ok" in hooks ? (hooks.ok ? hooks.value : null) : hooks;
      if (!hookRegistry || !ports.historyArtifacts)
        return terminal("unavailable", "none", "schedule-persistence-unavailable");
      const artifacts = ports.historyArtifacts;
      const task = resources.openTask(String(record.binding?.configurationGeneration));
      const correlation = {
        ...ports.correlation,
        sessionId: sessionId.from(`schedule-${attempt.id}`),
        traceId: traceId.from(attempt.id),
      };
      const journal = createTurnEventJournal({
        eventStore: ports.eventStore,
        clock: ports.clock,
        correlation,
        streamId: streamId.from(`schedule-attempt:${attempt.id}`),
      });
      const began = await journal.persist(
        [
          { kind: "session.started", correlation },
          {
            kind: "turn.started",
            correlation: { ...correlation, turnId: turnId.from(attempt.id) },
          },
        ],
        signal,
      );
      if (began.kind !== "persisted") {
        task.close();
        return terminal("unavailable", "none", "schedule-journal-unavailable");
      }
      const deadline = AbortSignal.timeout(Math.max(1, attempt.deadline - now()));
      const combined = AbortSignal.any([signal, deadline]);
      const gateway = createProductToolGateway({
        clock: ports.clock,
        resources,
        taskResources: task,
        registry: bundle.registry,
        runner: bundle.runner,
        journal,
        correlation,
        turnId: turnId.from(attempt.id),
        attemptId: attempt.id,
        disclosedToolNames: new Set(bundle.toolNames),
        hooks: hookRegistry,
        effectLedger: new Map(),
        historyArtifacts: ports.historyArtifacts,
        ...(ports.toolHost ? { toolHost: ports.toolHost } : {}),
        ...(ports.sandbox ? { sandbox: ports.sandbox } : {}),
        trust: {
          inspect: (id) =>
            bundle.capabilityRegistry.resolveById(capabilityId.from(id))?.trust ?? null,
        },
        ...(ports.toolPolicy ? { policy: ports.toolPolicy } : {}),
        // Scheduled work never inherits an interactive one-shot consent. Required effects report denial.
        confirmation: { resolve: async () => ({ kind: "unavailable" }) },
        delegation: {
          route: options.preferences().roles.default ?? null,
          binding: null,
          capabilities: idsFor(record),
          effects: ["observation", "mutation", "external", "interactive"],
        },
        async instructionsCurrent(checkSignal) {
          const current = schedules.store.get(workspace, record.id);
          if (!current.ok || current.value.generation < record.generation) return false;
          const attemptState = schedules.store.attempt(workspace, attempt.id);
          if (!attemptState.ok || attemptState.value.terminal !== null) return false;
          const authority = await validate(record, checkSignal);
          return (
            authority.ok && canonicalDigest(authority.value) === canonicalDigest(record.binding)
          );
        },
      });
      const run = async () => {
        try {
          const target = record.definition.target;
          const id =
            target.kind === "action" ? target.capability : "builtin:orchestration/workflow@1";
          const entry = bundle.registry.resolveByCapabilityId(capabilityId.from(id));
          if (!entry) return terminal("unavailable", "none", "target-unavailable");
          const handle = { id: attempt.id, generation: `schedule-${record.generation}` };
          if (target.kind === "workflow" && !link({ workflow: handle, task: null }))
            return terminal("uncertain", "uncertain", "workflow-link-unavailable");
          const input =
            target.kind === "action"
              ? target.input
              : {
                  operation: "execute",
                  handle,
                  definitionJson: canonicalJson(target.definition),
                  argumentsJson: canonicalJson(target.arguments),
                };
          const parsed = entry.manifest.inputSchema.safeParse(input);
          if (!parsed.success) return terminal("unavailable", "none", "target-input-invalid");
          let exactOutput: Readonly<Record<string, unknown>> | null = null;
          const outcome: ToolInvocationOutcome = await gateway.execute({
            captureExactOutput: (value) => {
              exactOutput = value;
            },
            invocationId: invocationId.from(attempt.id),
            toolCallId: attempt.id,
            capabilityId: entry.manifest.capabilityId,
            toolName: entry.manifest.name,
            version: entry.manifest.version,
            effect: entry.manifest.effectFor?.(parsed.data) ?? entry.manifest.effect,
            input: parsed.data,
            signal: combined,
          });
          if (target.kind === "workflow") {
            let cancellationDeadline: number | null = null;
            // A workflow receipt may be nonterminal. Settlement comes from its durable owner.
            for (;;) {
              const read = options.workflowStore?.get(handle);
              if (!read?.ok) break;
              const workflow = read.value;
              if (workflow.task) link({ workflow: handle, task: workflow.task });
              const settled = settledWorkflow(workflow, now());
              if (settled) return settled;
              if (combined.aborted) {
                // The original request signal already reaches the workflow owner.
                // Observe its settlement; do not issue a foreign cancel request.
                cancellationDeadline ??= Date.now() + 1000;
                if (Date.now() >= cancellationDeadline)
                  return terminal("uncertain", "uncertain", "workflow-cancellation-pending");
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          const receipt =
            outcome.status === "completed" ? processTaskReceiptSchema.safeParse(exactOutput) : null;
          if (receipt?.success && receipt.data.owner.invocationId === attempt.id) {
            if (!link({ task: receipt.data.handle, workflow: null }))
              return terminal("uncertain", "uncertain", "task-link-unavailable");
            let cancellationDeadline: number | null = null;
            for (;;) {
              const read = schedules.tasks.get(receipt.data.handle);
              if (!read.ok)
                return terminal("uncertain", "uncertain", "task-settlement-unavailable");
              const settled = settledTask(read.value, now());
              if (settled) return settled;
              if (combined.aborted) {
                cancellationDeadline ??= Date.now() + 1000;
                if (Date.now() >= cancellationDeadline)
                  return terminal("uncertain", "uncertain", "task-cancellation-pending");
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          let result: ScheduleTerminal["result"] = null;
          if ("output" in outcome) {
            const bytes = new TextEncoder().encode(canonicalJson(exactOutput ?? outcome.output));
            if (bytes.byteLength > 65_536)
              return terminal("failed", outcome.effect, "schedule-result-byte-limit");
            const digest = contentDigest.from(
              `sha-256:${createHash("sha256").update(bytes).digest("hex")}`,
            );
            const id = artifactId.from(`schedule-${attempt.id}`);
            const saved = await artifacts.ingest(
              {
                artifactId: id,
                mediaType: "application/json",
                encoding: "identity",
                sensitivity: "sensitive",
                origin: "capture",
                invocationId: invocationId.from(attempt.id),
                expectedDigest: digest,
                declaredByteLength: bytes.byteLength,
                content: (async function* () {
                  yield bytes;
                })(),
              },
              AbortSignal.timeout(5000),
            );
            if (!saved.ok) return terminal("uncertain", "uncertain", "schedule-result-unavailable");
            result = { artifactId: id, digest, byteLength: bytes.byteLength };
          }
          const status =
            outcome.status === "completed"
              ? "succeeded"
              : outcome.status === "malformed"
                ? "failed"
                : outcome.status;
          return terminal(
            status,
            outcome.effect,
            "reason" in outcome && /^[a-z0-9-]{1,128}$/.test(outcome.reason)
              ? outcome.reason
              : `target-${outcome.status}`,
            result,
          );
        } finally {
          task.close();
        }
      };
      const observed = await run();
      const settled =
        observed.status === "cancelled" && deadline.aborted && !signal.aborted
          ? { ...observed, status: "timed-out" as const, reason: "schedule-deadline-exhausted" }
          : observed;
      const finished = await journal.persist([
        {
          kind: "turn.completed",
          correlation: { ...correlation, turnId: turnId.from(attempt.id) },
          outcome:
            settled.status === "succeeded"
              ? { kind: "completed" }
              : settled.status === "cancelled" || settled.status === "timed-out"
                ? { kind: settled.status, effect: settled.effect }
                : settled.status === "uncertain"
                  ? { kind: "uncertain", effect: "uncertain" }
                  : { kind: "failed", effect: settled.effect },
        },
      ]);
      return finished.kind === "persisted"
        ? settled
        : terminal("uncertain", "uncertain", "schedule-settlement-journal-unavailable");
    },
    async reconcile(attempt) {
      if (attempt.workflow) {
        const read = options.workflowStore?.get(attempt.workflow);
        return read?.ok ? settledWorkflow(read.value, now()) : null;
      }
      if (attempt.task) {
        const read = schedules.tasks.get(attempt.task);
        return read.ok ? settledTask(read.value, now()) : null;
      }
      return null;
    },
    // The durable receipt is discoverable through history; acknowledgement never re-executes work.
    notify: schedules.notify,
  };
  const actions = createScheduleActions({
    store: schedules.store,
    workspace,
    now,
    authority: executor,
    ...(schedules.defaults ? { defaults: schedules.defaults } : {}),
  });
  const runtime = schedules.process
    ? createScheduleRuntime({
        store: schedules.store,
        workspace,
        executor,
        process: schedules.process,
        identities: schedules.identities,
        now,
      })
    : null;
  let release = () => {};
  const close = async () => {
    const clean = (await runtime?.close()) ?? true;
    if (clean) release();
    return clean;
  };
  if (runtime) {
    release = schedules.retain({ close });
    if (schedules.autostart !== false) runtime.start();
  }
  return {
    actions,
    wake: () => runtime?.wake() ?? Promise.resolve(),
    close,
    inspect: () =>
      runtime?.inspect() ?? { active: 0, stopped: true, failure: "schedule-host-unavailable" },
  };
}
export type ProductSchedules = ReturnType<typeof composeScheduleProductRuntime>;
