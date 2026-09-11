import { randomUUID } from "node:crypto";
import { canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import type { ClockPort } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import { validateDefinitionValue } from "../../domain/orchestration/definition-values.ts";
import { RESOURCE_DIMENSIONS } from "../../domain/orchestration/resource-admission.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import {
  decodeWorkflowDefinition,
  resolveWorkflowValue,
  validWorkflowArguments,
  WORKFLOW_LIMITS,
  type WorkflowNode,
  workflowPath,
  workflowReferences,
} from "../../domain/orchestration/workflow-definition.ts";
import {
  type WorkflowHandle,
  type WorkflowNodeRecord,
  type WorkflowRecord,
  type WorkflowResult,
  type WorkflowStore,
  workflowHandleSchema,
} from "../../domain/orchestration/workflow-state.ts";
import { containsRedactableSecret } from "../diagnostics/redaction.ts";
import type { WorkflowArtifacts } from "./workflow-artifacts.ts";
import type { WorkflowHost, WorkflowNodeOutcome } from "./workflow-host.ts";
import {
  expandWorkflow,
  nodeSettled,
  workflowDependencies,
  workflowInputs,
} from "./workflow-scheduling.ts";

const handleKey = (handle: WorkflowHandle) => canonicalJson(handle);
const allowed = (record: WorkflowRecord, host: WorkflowHost) =>
  record.owner.workspaceId === host.owner.workspaceId &&
  record.owner.sessionId === host.owner.sessionId &&
  record.authority === host.authority &&
  host.current(record);
const terminal = (record: WorkflowRecord) =>
  ["completed", "failed", "cancelled", "timed-out", "uncertain"].includes(record.state);
const message = (error: unknown) =>
  error instanceof Error && /^workflow-[a-z-]+$/.test(error.message)
    ? error.message
    : "workflow-recovery-required";

function validatedOutcome(
  template: WorkflowNode,
  outcome: WorkflowNodeOutcome,
): WorkflowNodeOutcome {
  if (outcome.state !== "completed") return outcome;
  try {
    const value = workflowPath(outcome.value, template.resultPath);
    if (validateDefinitionValue(template.resultSchema, value, WORKFLOW_LIMITS.valueBytes))
      return { ...outcome, value };
  } catch {
    /* An invalid result does not erase the native owner's effect evidence. */
  }
  return { ...outcome, state: "failed", reason: "workflow-result-schema" };
}

export function createWorkflowExecution(options: {
  store: WorkflowStore;
  artifacts: WorkflowArtifacts;
  clock: ClockPort;
}) {
  const { store, artifacts } = options;
  const now = () => Number(options.clock.now());
  const active = new Map<string, AbortController>();
  const inspect = (handle: WorkflowHandle, host: WorkflowHost): WorkflowResult<WorkflowRecord> => {
    const record = store.get(handle);
    return record.ok && !allowed(record.value, host) ? err({ code: "denied" }) : record;
  };
  async function results(
    record: WorkflowRecord,
    signal: AbortSignal,
    itemKey: string | null = null,
    required?: ReadonlySet<string>,
    consumer?: WorkflowNode,
  ) {
    const values = new Map<string, unknown>();
    for (const template of record.definition.nodes) {
      if (!record.expanded.includes(template.key) || (required && !required.has(template.key)))
        continue;
      const nodes = record.nodes.filter((node) => node.template === template.key);
      const sameMap =
        itemKey !== null &&
        consumer?.forEach &&
        template.forEach &&
        canonicalDigest(consumer.forEach) === canonicalDigest(template.forEach);
      const same = sameMap ? nodes.find((node) => node.itemKey === itemKey) : undefined;
      if (same?.state === "completed" && same.result) {
        values.set(template.key, await artifacts.read(same.result, signal));
        continue;
      }
      if (!nodes.every((node) => node.state === "completed")) continue;
      const output: unknown[] = [];
      for (const node of nodes) {
        if (!node.result) throw new Error("workflow-result-unavailable");
        output.push(await artifacts.read(node.result, signal));
      }
      values.set(template.key, template.forEach ? output : output[0]);
    }
    return values;
  }
  function fingerprint(
    record: WorkflowRecord,
    node: WorkflowNodeRecord,
    template: WorkflowNode,
    input: unknown,
  ) {
    return canonicalDigest({
      template,
      input,
      sourceGeneration: record.sourceGeneration,
      route: record.routes[template.key] ?? null,
      dependencies:
        workflowDependencies(record, node)?.map((dependency) => ({
          key: dependency.key,
          fingerprint: dependency.fingerprint,
          result: dependency.result,
        })) ?? null,
    });
  }
  return {
    inspect,
    async admit(
      input: {
        handle: WorkflowHandle;
        definition: unknown;
        arguments: unknown;
        reuse?: WorkflowHandle;
      },
      host: WorkflowHost,
      signal: AbortSignal,
    ): Promise<WorkflowResult<WorkflowRecord>> {
      if (!workflowHandleSchema.safeParse(input.handle).success)
        return err({ code: "invalid-handle" });
      const graph = decodeWorkflowDefinition(input.definition);
      if (!graph.ok) return err({ code: "invalid-definition" });
      if (!validWorkflowArguments(graph.definition, input.arguments))
        return err({ code: "invalid-arguments" });
      if (containsRedactableSecret(canonicalJson(input)))
        return err({ code: "secret-in-workflow-input" });
      if (host.validate(graph.definition).length > 0)
        return err({ code: "workflow-capability-unavailable" });
      const prior = input.reuse ? inspect(input.reuse, host) : null;
      if (prior && (!prior.ok || !terminal(prior.value)))
        return err({ code: "reuse-source-unavailable" });
      const limits: Record<string, number> = {};
      const declared = host.resources.remainingBudget();
      for (const dimension of RESOURCE_DIMENSIONS) {
        if (
          declared[dimension] === undefined &&
          graph.definition.limits[dimension] === undefined &&
          (!prior?.ok || prior.value.limits[dimension] === undefined)
        )
          continue;
        const amount = Math.min(
          host.resources.remaining(dimension),
          graph.definition.limits[dimension] ?? Number.MAX_SAFE_INTEGER,
          prior?.ok
            ? (prior.value.limits[dimension] ?? Number.MAX_SAFE_INTEGER)
            : Number.MAX_SAFE_INTEGER,
        );
        if (Number.isSafeInteger(amount)) limits[dimension] = Math.max(0, amount);
      }
      const createdAt = now();
      const record: WorkflowRecord = {
        version: 1,
        handle: input.handle,
        revision: 1,
        intent: canonicalDigest({
          ...input,
          routes: host.routes(graph.definition),
          owner: [host.owner.sessionId, host.owner.workspaceId],
          authority: host.authority,
        }),
        definition: graph.definition,
        definitionDigest: graph.digest,
        arguments: JSON.parse(canonicalJson(input.arguments)),
        owner: host.owner,
        authority: host.authority,
        sourceGeneration: host.sourceGeneration,
        routes: host.routes(graph.definition),
        createdAt,
        deadline: Math.min(
          host.resources.expiresAt,
          createdAt + (graph.definition.limits.wallTimeMs ?? 1_800_000),
          prior?.ok ? prior.value.deadline : Number.MAX_SAFE_INTEGER,
        ),
        updatedAt: createdAt,
        state: "admitted",
        executor: null,
        task: null,
        nodes: [],
        expanded: [],
        limits,
        spent: {
          ...(prior?.ok ? prior.value.spent : {}),
          operations: (prior?.ok ? (prior.value.spent.operations ?? 0) : 0) + 1,
        },
        output: null,
        reusedFrom: input.reuse ?? null,
      };
      const admitted = await host.resources.execute({
        operation: randomUUID(),
        attempt: "1",
        generation: host.resources.generation,
        unit: {
          id: workUnitId(randomUUID()),
          effect: "mutation",
          priority: "interactive",
          conflictKeys: [conflictKey("workflow", handleKey(input.handle))],
          dependencies: [],
          deadline: null,
          expectedOutputBytes: WORKFLOW_LIMITS.valueBytes,
          retry: NO_RETRY,
          scopeId: null,
        },
        amounts: { operations: 1 },
        inputBytes: Buffer.byteLength(canonicalJson(input)),
        signal,
        async run(stop) {
          return { value: store.create(record, stop), terminated: true };
        },
      });
      return admitted.kind === "completed"
        ? admitted.value
        : err({ code: "admission-unavailable" });
    },
    control(
      handle: WorkflowHandle,
      expectedRevision: number,
      action: "pause" | "cancel",
      host: WorkflowHost,
    ) {
      const read = store.get(handle);
      if (!read.ok) return read;
      if (
        read.value.owner.workspaceId !== host.owner.workspaceId ||
        read.value.owner.sessionId !== host.owner.sessionId
      )
        return err({ code: "denied" });
      if (terminal(read.value)) return read;
      const changed = store.change(handle, expectedRevision, (record) =>
        ok({
          ...record,
          revision: record.revision + 1,
          updatedAt: now(),
          state: action === "pause" ? "paused" : "cancelled",
        }),
      );
      if (changed.ok && action === "cancel") active.get(handleKey(handle))?.abort();
      return changed;
    },
    async drive(
      handle: WorkflowHandle,
      host: WorkflowHost,
      signal: AbortSignal,
    ): Promise<WorkflowResult<WorkflowRecord>> {
      const read = inspect(handle, host);
      if (!read.ok || terminal(read.value)) return read;
      if (active.has(handleKey(handle))) return err({ code: "workflow-already-running" });
      if (read.value.executor !== null && !(await host.fenced(read.value.task)))
        return err({ code: "workflow-owner-unsettled" });
      const remaining: Record<string, number> = {};
      for (const dimension of RESOURCE_DIMENSIONS)
        if (read.value.limits[dimension] !== undefined)
          remaining[dimension] = Math.max(
            0,
            (read.value.limits[dimension] ?? 0) - (read.value.spent[dimension] ?? 0),
          );
      remaining.wallTimeMs = Math.max(0, read.value.deadline - now());
      const resources = host.resources.subdivide(remaining);
      if (!resources) return err({ code: "workflow-resource-exhausted" });
      const controller = new AbortController();
      const stop = AbortSignal.any([signal, controller.signal]);
      active.set(handleKey(handle), controller);
      const executor = randomUUID();
      let current = read.value;
      const persist = (update: (record: WorkflowRecord) => WorkflowRecord) => {
        const observed = store.get(handle);
        if (
          !observed.ok ||
          (observed.value.executor !== executor && observed.value.executor !== null)
        )
          throw new Error("workflow-owner-changed");
        const changed = store.change(handle, observed.value.revision, (record) =>
          ok({ ...update(record), revision: record.revision + 1, updatedAt: now() }),
        );
        if (!changed.ok) throw new Error("workflow-checkpoint-unavailable");
        current = changed.value;
        return current;
      };
      const updateNode = (
        key: string,
        update: (node: WorkflowNodeRecord) => WorkflowNodeRecord,
        additional?: (record: WorkflowRecord) => WorkflowRecord,
      ) =>
        persist((record) => ({
          ...(additional?.(record) ?? record),
          nodes: record.nodes.map((node) => (node.key === key ? update(node) : node)),
        }));
      const pending = new Map<string, Promise<void>>();
      try {
        const claimed = store.change(handle, current.revision, (record) =>
          ok({
            ...record,
            executor,
            state: "running",
            revision: record.revision + 1,
            updatedAt: now(),
            nodes: record.nodes.map((node) =>
              node.state === "running"
                ? {
                    ...node,
                    state: "uncertain",
                    effect: "uncertain",
                    reason: "workflow-interrupted-effect",
                  }
                : node,
            ),
          }),
        );
        if (!claimed.ok) return claimed;
        current = claimed.value;
        const previous = current.reusedFrom ? store.get(current.reusedFrom) : null;
        const execute = async (instance: WorkflowNodeRecord, template: WorkflowNode) => {
          let observedOutcome: WorkflowNodeOutcome | undefined;
          try {
            const values = await results(
              current,
              stop,
              instance.itemKey,
              new Set(
                workflowReferences(template).flatMap((reference) =>
                  reference.from === "node" ? [reference.node] : [],
                ),
              ),
              template,
            );
            const input = workflowInputs(template, current, values, instance.item);
            const bound = fingerprint(current, instance, template, input);
            const reusable = previous?.ok
              ? previous.value.nodes.find(
                  (node) =>
                    node.key === instance.key &&
                    node.fingerprint === bound &&
                    node.state === "completed",
                )
              : null;
            if (
              reusable?.result &&
              (await host.reusable(
                template,
                reusable,
                previous?.ok ? previous.value : current,
                stop,
              ))
            ) {
              const value = await artifacts.read(reusable.result, stop);
              if (
                validateDefinitionValue(template.resultSchema, value, WORKFLOW_LIMITS.valueBytes)
              ) {
                updateNode(instance.key, (node) => ({
                  ...node,
                  state: "completed",
                  fingerprint: bound,
                  result: reusable.result,
                  effect: reusable.effect,
                  reason: "workflow-result-reused",
                  observed: reusable.observed,
                  settledAt: now(),
                }));
                return;
              }
            }
            const priorNode = previous?.ok
              ? previous.value.nodes.find((node) => node.key === instance.key)
              : null;
            if (priorNode && priorNode.effect !== "none")
              throw new Error("workflow-effect-requires-new-admission");
            if (
              template.when &&
              canonicalDigest(
                resolveWorkflowValue(template.when.value, current.arguments, values, instance.item),
              ) !== canonicalDigest(template.when.equals)
            ) {
              updateNode(instance.key, (node) => ({
                ...node,
                state: "skipped",
                reason: "workflow-condition-false",
                settledAt: now(),
              }));
              return;
            }
            const reservation = host.reservation(template, current);
            if (!reservation) throw new Error("workflow-resource-unavailable");
            const invocation = `node-${canonicalDigest([handle, instance.key, instance.attempts + 1]).slice(7)}`;
            const admitted = await resources.execute({
              operation: invocation,
              attempt: "admission",
              generation: resources.generation,
              unit: {
                id: workUnitId(invocation),
                effect: "mutation",
                priority: "interactive",
                conflictKeys: [conflictKey("workflow", handleKey(handle))],
                dependencies: [],
                deadline: null,
                expectedOutputBytes: 1024,
                retry: NO_RETRY,
                scopeId: null,
              },
              amounts: { operations: 1 },
              inputBytes: Buffer.byteLength(canonicalJson(input)),
              signal: stop,
              async run(admittedSignal) {
                if (
                  admittedSignal.aborted ||
                  !host.current(current) ||
                  current.state !== "running" ||
                  now() >= current.deadline
                )
                  return { value: false, terminated: true };
                for (const dimension of RESOURCE_DIMENSIONS) {
                  const value = reservation[dimension] ?? 0;
                  if (
                    !Number.isSafeInteger(value) ||
                    value < 0 ||
                    value + (current.spent[dimension] ?? 0) >
                      (current.limits[dimension] ?? Number.MAX_SAFE_INTEGER)
                  )
                    return { value: false, terminated: true };
                }
                updateNode(
                  instance.key,
                  (node) => ({
                    ...node,
                    state: "running",
                    attempts: node.attempts + 1,
                    invocation,
                    fingerprint: bound,
                    startedAt: now(),
                    usage: reservation,
                  }),
                  (record) => ({
                    ...record,
                    spent: Object.fromEntries(
                      RESOURCE_DIMENSIONS.map((d) => [
                        d,
                        (record.spent[d] ?? 0) + (reservation[d] ?? 0),
                      ]),
                    ),
                  }),
                );
                return { value: true, terminated: true };
              },
            });
            if (admitted.kind !== "completed" || !admitted.value)
              throw new Error("workflow-admission-refused");
            let outcome: WorkflowNodeOutcome;
            const admittedNode = current.nodes.find((node) => node.key === instance.key);
            if (!admittedNode) throw new Error("workflow-node-unavailable");
            if (template.kind === "condition")
              outcome = {
                state: "completed",
                effect: "none",
                value: {
                  matches:
                    canonicalDigest(
                      resolveWorkflowValue(
                        template.value,
                        current.arguments,
                        values,
                        instance.item,
                      ),
                    ) === canonicalDigest(template.equals),
                },
              };
            else if (template.kind === "join")
              outcome = {
                state: "completed",
                effect: "none",
                value: {
                  nodes: (workflowDependencies(current, admittedNode) ?? []).map((node) => ({
                    key: node.key,
                    state: node.state,
                    result: node.result,
                  })),
                },
              };
            else {
              const child = resources.subdivide(template.limits);
              if (!child) throw new Error("workflow-node-budget-unavailable");
              try {
                outcome = await host.execute(template, input, current, admittedNode, child, stop);
              } finally {
                child.close();
              }
            }
            observedOutcome = outcome;
            outcome = validatedOutcome(template, outcome);
            const result =
              outcome.state === "completed"
                ? await artifacts.retain(current, invocation, outcome.value)
                : null;
            const retry =
              outcome.state === "failed" &&
              outcome.effect === "none" &&
              template.retries >= admittedNode.attempts &&
              !stop.aborted;
            const usage = { ...reservation };
            for (const dimension of RESOURCE_DIMENSIONS) {
              const measured = outcome.usage?.[dimension];
              if (measured !== undefined) {
                if (!Number.isSafeInteger(measured) || measured < 0)
                  throw new Error("workflow-invalid-usage");
                usage[dimension] = Math.max(usage[dimension] ?? 0, measured);
              }
            }
            updateNode(
              instance.key,
              (node) => ({
                ...node,
                state: retry ? "pending" : outcome.state,
                effect: outcome.effect,
                reason: outcome.reason?.slice(0, 256) ?? null,
                result,
                question: outcome.question ?? null,
                usage,
                ...(outcome.usage ? { measured: outcome.usage } : {}),
                observed: [...(outcome.observations ?? [])].slice(0, 64),
                settledAt: retry || outcome.state === "waiting" ? null : now(),
              }),
              (record) => ({
                ...record,
                spent: Object.fromEntries(
                  RESOURCE_DIMENSIONS.map((d) => [
                    d,
                    (record.spent[d] ?? 0) + (usage[d] ?? 0) - (reservation[d] ?? 0),
                  ]),
                ),
              }),
            );
          } catch (error) {
            updateNode(instance.key, (node) => ({
              ...node,
              state:
                node.state === "running" && !observedOutcome
                  ? "uncertain"
                  : stop.aborted
                    ? "cancelled"
                    : "failed",
              effect: observedOutcome?.effect ?? (node.state === "running" ? "uncertain" : "none"),
              reason: message(error),
              settledAt: now(),
            }));
          }
        };
        for (;;) {
          const observed = inspect(handle, host);
          if (!observed.ok) throw new Error("workflow-authority-unavailable");
          current = observed.value;
          if (stop.aborted || now() >= current.deadline || current.state !== "running") {
            if (pending.size > 0) {
              await Promise.all(pending.values());
              continue;
            }
            if (current.state === "running")
              persist((record) => ({
                ...record,
                state: now() >= record.deadline ? "timed-out" : "cancelled",
              }));
            break;
          }
          const sources = new Set(
            current.definition.nodes.flatMap((node) =>
              !current.expanded.includes(node.key) && node.forEach?.source.from === "node"
                ? [node.forEach.source.node]
                : [],
            ),
          );
          const allResults = await results(current, stop, null, sources);
          const expanded = expandWorkflow(current, allResults);
          if (
            expanded.nodes.length !== current.nodes.length ||
            expanded.expanded.length !== current.expanded.length
          )
            persist(() => expanded);
          let started = false;
          for (const instance of current.nodes) {
            if (pending.has(instance.key)) continue;
            const template = current.definition.nodes.find(
              (node) => node.key === instance.template,
            );
            if (!template) throw new Error("workflow-template-unavailable");
            if (instance.state === "waiting") {
              const settled = validatedOutcome(
                template,
                await host.question(instance, current, stop),
              );
              if (settled.state !== "waiting") {
                const valid = settled.state === "completed";
                const result = valid
                  ? await artifacts.retain(
                      current,
                      instance.invocation ?? instance.key,
                      settled.value,
                    )
                  : null;
                updateNode(instance.key, (node) => ({
                  ...node,
                  state: settled.state,
                  result,
                  effect: settled.effect,
                  reason: settled.reason ?? null,
                  settledAt: now(),
                }));
                started = true;
              }
              continue;
            }
            if (instance.state !== "pending") continue;
            const stopped = current.nodes.some(
              (node) =>
                ["failed", "cancelled", "timed-out", "uncertain"].includes(node.state) &&
                current.definition.nodes.find((candidate) => candidate.key === node.template)
                  ?.onFailure === "stop",
            );
            if (stopped) {
              updateNode(instance.key, (node) => ({
                ...node,
                state: "skipped",
                reason: "workflow-required-node-failed",
                settledAt: now(),
              }));
              started = true;
              continue;
            }
            const dependencies = workflowDependencies(current, instance);
            if (!dependencies?.every(nodeSettled)) continue;
            if (
              !(template.kind === "join" && template.policy === "settled") &&
              dependencies.some((node) => node.state !== "completed")
            ) {
              updateNode(instance.key, (node) => ({
                ...node,
                state: "skipped",
                reason: "workflow-prerequisite-unsatisfied",
                settledAt: now(),
              }));
              started = true;
              continue;
            }
            if (pending.size >= current.definition.concurrency) break;
            const task = execute(instance, template).finally(() => pending.delete(instance.key));
            pending.set(instance.key, task);
            started = true;
          }
          if (pending.size > 0) {
            await Promise.race(pending.values());
            continue;
          }
          if (started) continue;
          const uncertain = current.nodes.some((node) => node.state === "uncertain");
          const waiting = current.nodes.some((node) => node.state === "waiting");
          const incomplete =
            current.nodes.some((node) => node.state === "pending") ||
            current.expanded.length !== current.definition.nodes.length;
          const failed =
            RESOURCE_DIMENSIONS.some(
              (dimension) =>
                (current.spent[dimension] ?? 0) >
                (current.limits[dimension] ?? Number.MAX_SAFE_INTEGER),
            ) ||
            current.nodes.some((node) => ["failed", "cancelled", "timed-out"].includes(node.state));
          let output = null;
          if (!uncertain && !waiting && !incomplete && !failed) {
            const values = await results(
              current,
              stop,
              null,
              new Set(
                Object.values(current.definition.outputs).flatMap((reference) =>
                  reference.from === "node" ? [reference.node] : [],
                ),
              ),
            );
            const value = Object.fromEntries(
              Object.entries(current.definition.outputs).map(([key, reference]) => [
                key,
                resolveWorkflowValue(reference, current.arguments, values),
              ]),
            );
            output = await artifacts.retain(current, "output", value);
          }
          persist((record) => ({
            ...record,
            state: uncertain
              ? "uncertain"
              : waiting
                ? "waiting"
                : failed || incomplete
                  ? "failed"
                  : "completed",
            output,
          }));
          break;
        }
        persist((record) => ({ ...record, executor: null }));
        return ok(current);
      } catch (error) {
        await Promise.allSettled(pending.values());
        try {
          persist((record) => ({
            ...record,
            state: record.nodes.some(
              (node) => node.state === "running" || node.state === "uncertain",
            )
              ? "uncertain"
              : "failed",
          }));
        } catch {
          return err({ code: "recovery-required" });
        }
        return err({ code: message(error) });
      } finally {
        active.delete(handleKey(handle));
        resources.close();
        try {
          if (store.get(handle).ok && current.executor === executor)
            persist((record) => ({ ...record, executor: null }));
        } catch {
          /* Durable owner must be reconciled before another drive. */
        }
      }
    },
  };
}
export type WorkflowExecution = ReturnType<typeof createWorkflowExecution>;
