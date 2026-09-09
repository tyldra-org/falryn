/** Runs bounded dependency graphs exclusively through the product tool gateway. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  boundedJson,
  type CompositionGraph,
  type CompositionNode,
  type CompositionProvenance,
  MAX_COMPOSITION_BYTES,
  MAX_TRANSFER_BYTES,
  parseCompositionGraph,
} from "../../domain/capabilities/composition.ts";
import type { CapabilityRegistry } from "../../domain/capabilities/index.ts";
import {
  type ClockPort,
  capabilityId,
  type InvocationId,
  invocationId,
  type TurnId,
} from "../../domain/foundation/index.ts";
import type { EffectCertainty, TerminalOutcome } from "../../domain/orchestration/index.ts";
import type { SessionCorrelation } from "../../domain/sessions/index.ts";
import type {
  BoundToolInvocation,
  ToolInvocationOutcome,
  ToolInvocationRecord,
  ToolRegistry,
} from "../../domain/tools/index.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import type { ToolRunnerPort } from "../runtime/tool-call-loop.ts";
import type { TurnEventJournalPort } from "../runtime/turn-event-journal.ts";

export type CapabilityCompositionOptions = {
  readonly registry: ToolRegistry;
  readonly capabilities?: CapabilityRegistry;
  readonly nativeRunner: ToolRunnerPort;
  readonly gateway: ToolRunnerPort;
  readonly taskResources: ProductTaskResources;
  readonly journal: TurnEventJournalPort;
  readonly clock: ClockPort;
  readonly correlation: SessionCorrelation;
  readonly turnId: TurnId;
  readonly disclosedToolNames: ReadonlySet<string>;
};
export type CompositionResult = {
  readonly status: ToolInvocationOutcome["status"];
  readonly reason: string | null;
  readonly records: readonly ToolInvocationRecord[];
};
const graphCapability = capabilityId.from("falryn:composition:v1");
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function failed(reason: string): ToolInvocationOutcome {
  return { status: "unavailable", reason, effect: "none" };
}
function effect(records: readonly ToolInvocationRecord[]): EffectCertainty {
  if (records.some((record) => record.outcome.effect === "uncertain")) return "uncertain";
  if (records.some((record) => record.outcome.effect === "partial")) return "partial";
  return records.some((record) => record.outcome.effect === "completed") ? "completed" : "none";
}
function terminal(
  status: ToolInvocationOutcome["status"],
  observed: EffectCertainty,
): TerminalOutcome {
  if (status === "completed") return { kind: "completed" };
  if (status === "uncertain") return { kind: "uncertain", effect: "uncertain" };
  if (status === "cancelled" || status === "timed-out") return { kind: status, effect: observed };
  return { kind: "failed", effect: observed };
}

export function createCapabilityComposition(options: CapabilityCompositionOptions) {
  const admitted = new Set<string>();
  const entryFor = (node: CompositionNode) =>
    options.registry.resolveByCapabilityId(capabilityId.from(node.capabilityId));
  function bindingReason(node: CompositionNode): string | null {
    const entry = entryFor(node);
    if (
      entry === null ||
      entry.manifest.version !== node.capabilityVersion ||
      (entry.manifest.effectFor === undefined && entry.manifest.effect !== node.effect)
    )
      return "capability-binding-mismatch";
    if (entry.manifest.effectFor && node.transfers.length === 0) {
      const input = entry.manifest.inputSchema.safeParse(node.input);
      if (!input.success) return "composition-node-input-invalid";
      if (entry.manifest.effectFor(input.data) !== node.effect)
        return "capability-binding-mismatch";
    }
    if (!options.disclosedToolNames.has(entry.manifest.name)) return "tool-not-disclosed";
    if (options.nativeRunner.hasBinding?.(entry.manifest.capabilityId) !== true)
      return "missing-native-binding";
    if (options.capabilities !== undefined) {
      const candidate = options.capabilities.entries.find(
        (item) => item.capabilityId === entry.manifest.capabilityId,
      );
      if (
        options.capabilities.generation !== options.registry.generation ||
        candidate === undefined
      )
        return "stale-capability-binding";
      const state = candidate.state;
      if (
        !state.executable ||
        state.health !== "healthy" ||
        state.availability !== "available" ||
        !state.operational.allowed ||
        state.operational.denied ||
        state.operational.quarantined ||
        state.operational.incompatible
      )
        return "native-binding-unavailable";
    }
    return null;
  }
  function bindingDigest(node: CompositionNode): string {
    const entry = entryFor(node);
    return hash(
      JSON.stringify(
        entry === null
          ? node.capabilityId
          : {
              identity: entry.manifest.identity,
              generation: options.registry.generation,
              input: z.toJSONSchema(entry.manifest.inputSchema),
              output: z.toJSONSchema(entry.manifest.outputSchema),
              effect: entry.manifest.effect,
              limits: entry.manifest.limits,
              scope: options.correlation,
              task: options.taskResources.id,
            },
      ),
    );
  }
  function record(
    node: CompositionNode,
    graphId: string,
    outcome: ToolInvocationOutcome,
    suppliedIds: ReadonlyMap<string, InvocationId> = new Map(),
  ): ToolInvocationRecord {
    return {
      invocationId:
        suppliedIds.get(node.id) ??
        invocationId.from(`composition-${hash(`${graphId}:${node.id}`)}`),
      toolCallId: node.id,
      toolName: entryFor(node)?.manifest.name ?? node.capabilityId,
      capabilityId: capabilityId.from(node.capabilityId),
      effectClass: node.effect,
      outcome,
    };
  }

  async function execute(
    value: unknown,
    signal: AbortSignal,
    suppliedIds: ReadonlyMap<string, InvocationId> = new Map(),
  ): Promise<CompositionResult> {
    const parsed = parseCompositionGraph(value);
    if (!parsed.ok) return { status: "malformed", reason: parsed.reason, records: [] };
    const graph = parsed.graph;
    if (
      graph.generation !== options.registry.generation ||
      graph.generation !== options.correlation.configurationGeneration
    )
      return { status: "unavailable", reason: "stale-composition-generation", records: [] };
    const graphId = hash(`${options.correlation.sessionId}:${options.turnId}:${graph.id}`);
    if (admitted.has(graphId))
      return { status: "unavailable", reason: "composition-already-admitted", records: [] };
    if (admitted.size >= 512)
      return { status: "unavailable", reason: "composition-admission-bound", records: [] };
    admitted.add(graphId);
    const graphDigest = hash(JSON.stringify(graph));
    const topology = graph.nodes.map((node) => ({
      nodeId: hash(node.id),
      dependencies: node.dependencies.map(hash),
    }));
    const provenance: CompositionProvenance = {
      version: 1,
      graphId,
      graphDigest,
      nodeId: hash(graph.id),
      bindingDigest: graphDigest,
      dependencies: [],
      topology,
    };
    const correlation = { ...options.correlation, turnId: options.turnId };
    const controlId = invocationId.from(`composition-${graphId}`);
    const start = await options.journal.persist(
      [
        {
          kind: "capability.invocation.started",
          correlation,
          invocationId: controlId,
          capabilityId: graphCapability,
          capabilityVersion: 1,
          inputDigest: graphDigest,
          composition: provenance,
        },
      ],
      signal,
    );
    if (
      start.kind !== "persisted" ||
      start.receipts.some((receipt) => receipt.kind === "duplicate")
    )
      return { status: "unavailable", reason: "composition-journal-or-replay", records: [] };

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    let expired = false;
    const remaining = Math.min(
      graph.timeoutMs,
      options.taskResources.expiresAt - Number(options.clock.now()),
    );
    const timer = setTimeout(
      () => {
        expired = true;
        controller.abort();
      },
      Math.max(0, remaining),
    );
    if (remaining <= 0) {
      expired = true;
      controller.abort();
    }
    const results = new Map<string, ToolInvocationRecord>();
    const exact = new Map<string, Readonly<Record<string, unknown>>>();
    let transferBytes = 0;
    let retainedBytes = 0;
    let reason: string | null = null;
    const invalid = graph.nodes.find(
      (node) =>
        bindingReason(node) !== null ||
        (node.transfers.length === 0 &&
          !entryFor(node)?.manifest.inputSchema.safeParse(node.input).success),
    );

    try {
      if (invalid !== undefined) {
        reason = bindingReason(invalid) ?? "composition-node-input-invalid";
        for (const node of graph.nodes)
          results.set(node.id, record(node, graphId, failed(reason), suppliedIds));
      }
      while (results.size < graph.nodes.length) {
        const ready = graph.nodes
          .filter(
            (node) => !results.has(node.id) && node.dependencies.every((id) => results.has(id)),
          )
          .slice(0, graph.maxConcurrent);
        await Promise.all(
          ready.map(async (node) => {
            const nodeProvenance = {
              ...provenance,
              nodeId: hash(node.id),
              bindingDigest: bindingDigest(node),
              dependencies: node.dependencies.map(hash),
            };
            let outcome: ToolInvocationOutcome;
            const refusal = bindingReason(node);
            if (controller.signal.aborted)
              outcome = { status: expired ? "timed-out" : "cancelled", effect: "none" };
            else if (refusal !== null) outcome = failed(refusal);
            else if (
              node.dependencies.some((id) => results.get(id)?.outcome.status !== "completed")
            )
              outcome = failed("composition-dependency-incomplete");
            else {
              const input = { ...node.input };
              let transferFailed = false;
              for (const transfer of node.transfers) {
                let output: unknown = exact.get(transfer.from);
                for (const key of transfer.path) {
                  output =
                    typeof output === "object" && output !== null && Object.hasOwn(output, key)
                      ? Reflect.get(output, key)
                      : undefined;
                }
                const encoded = boundedJson(output, MAX_TRANSFER_BYTES);
                if (encoded === null) {
                  transferFailed = true;
                  break;
                }
                transferBytes += new TextEncoder().encode(encoded).length;
                if (transferBytes > MAX_COMPOSITION_BYTES) {
                  transferFailed = true;
                  break;
                }
                input[transfer.target] = JSON.parse(encoded);
              }
              const entry = entryFor(node);
              if (transferFailed || entry === null)
                outcome = failed("composition-transfer-unavailable");
              else {
                const identity = record(node, graphId, failed("pending"), suppliedIds);
                try {
                  outcome = await options.gateway.execute({
                    invocationId: identity.invocationId,
                    toolCallId: node.id,
                    toolName: entry.manifest.name,
                    capabilityId: entry.manifest.capabilityId,
                    version: node.capabilityVersion,
                    effect: node.effect,
                    input,
                    signal: controller.signal,
                    composition: nodeProvenance,
                    captureExactOutput(output) {
                      const encoded = boundedJson(output, MAX_TRANSFER_BYTES);
                      if (encoded === null) return;
                      const bytes = new TextEncoder().encode(encoded).length;
                      if (retainedBytes + bytes > MAX_COMPOSITION_BYTES) return;
                      retainedBytes += bytes;
                      exact.set(node.id, JSON.parse(encoded));
                    },
                  });
                } catch {
                  outcome = {
                    status: "uncertain",
                    effect: "uncertain",
                    recoveryHint: "composition-native-settlement-unobserved",
                  };
                }
              }
            }
            results.set(
              node.id,
              record(node, graphId, { ...outcome, composition: nodeProvenance }, suppliedIds),
            );
          }),
        );
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      exact.clear();
    }
    const records = graph.nodes.flatMap((node) => {
      const result = results.get(node.id);
      return result === undefined ? [] : [result];
    });
    const status = records.every((item) => item.outcome.status === "completed")
      ? "completed"
      : records.some((item) => item.outcome.status === "uncertain")
        ? "uncertain"
        : expired
          ? "timed-out"
          : signal.aborted
            ? "cancelled"
            : "partial";
    const completedProvenance: CompositionProvenance = {
      ...provenance,
      topology: topology.map((node, index) => ({
        ...node,
        status: records[index]?.outcome.status,
      })),
    };
    const settled = await options.journal.persist([
      {
        kind: "capability.invocation.completed",
        correlation,
        invocationId: controlId,
        capabilityId: graphCapability,
        outcome: terminal(status, effect(records)),
        observedStatus: status,
        composition: completedProvenance,
      },
    ]);
    return settled.kind === "persisted"
      ? { status, reason, records }
      : { status: "uncertain", reason: "composition-settlement-not-persisted", records };
  }

  const runner: ToolRunnerPort = {
    execute: (request) => options.gateway.execute(request),
    async executeBatch(
      batch: readonly BoundToolInvocation[],
      signal: AbortSignal,
      maxConcurrent: number,
    ) {
      if (batch.length === 0) return [];
      const graph: CompositionGraph = {
        version: 1,
        id: hash(batch.map((item) => item.invocationId).join(":")),
        generation: options.registry.generation,
        maxConcurrent,
        timeoutMs: 30 * 60 * 1000,
        nodes: batch.map((item) => ({
          id: item.proposal.toolCallId,
          capabilityId: item.descriptor.id,
          capabilityVersion: item.descriptor.version,
          effect: item.descriptor.effect,
          input: item.input,
          dependencies: [],
          transfers: [],
        })),
      };
      const result = await execute(
        graph,
        signal,
        new Map(batch.map((item) => [item.proposal.toolCallId, item.invocationId])),
      );
      return batch.map((item, index) => ({
        invocationId: item.invocationId,
        toolCallId: item.proposal.toolCallId,
        toolName: item.descriptor.name,
        capabilityId: item.descriptor.id,
        effectClass: item.descriptor.effect,
        outcome:
          result.status === "uncertain" && result.reason === "composition-settlement-not-persisted"
            ? { status: "uncertain", effect: "uncertain", recoveryHint: result.reason }
            : (result.records[index]?.outcome ?? failed(result.reason ?? "composition-incomplete")),
      }));
    },
  };
  return { execute: (value: unknown, signal: AbortSignal) => execute(value, signal), runner };
}
