/** Decisions are evidence, not execution. Only committed, disclosed requests leave this owner. */
import { createHash } from "node:crypto";
import type { HookDecision } from "../../domain/extensions/hook-protocol.ts";
import type { TurnId } from "../../domain/foundation/index.ts";
import type {
  RecordedHookDecision,
  ToolHookEnvelope,
  ToolRegistry,
} from "../../domain/tools/index.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { historyDigest, type SessionHistory } from "../sessions/session-history.ts";

export type HookToolEffect = {
  readonly id: string;
  readonly request: Extract<
    Extract<HookDecision, { kind: "external-effect-request" }>["request"],
    { kind: "tool" }
  >;
};

export function createToolHookJournal(options: {
  readonly history: SessionHistory;
  readonly resources: ProductTaskResources;
  readonly turnId: TurnId;
  readonly request: ToolRunnerRequest;
  readonly registry: ToolRegistry;
  readonly disclosedToolNames: ReadonlySet<string>;
  readonly effects: HookToolEffect[];
}) {
  let committed = true;
  const warnings: { hookId: string; reason: string }[] = [];
  return {
    get committed() {
      return committed;
    },
    warnings,
    plan: (envelope: ToolHookEnvelope) => async (order: readonly string[]) => {
      const saved = await options.history.record(
        options.turnId,
        {
          version: 1,
          type: "gate",
          id: `${options.request.invocationId}:${envelope.phase}:hook-plan`,
          generation: Number(options.registry.generation),
          invocationId: String(options.request.invocationId),
          proposalId: options.request.toolCallId,
          stage: envelope.phase === "pre" ? "pre-hook" : "post-hook",
          decision: "hook-chain-bound",
          declaredEffect: envelope.catalog.payload.declaredEffect,
          cancelled: options.request.signal.aborted,
          hook: {
            hookId: "runner",
            factId: envelope.catalog.factId,
            registrationGeneration: Number(envelope.registrationGeneration),
            configurationGeneration: envelope.catalog.configurationGeneration,
            catalogGeneration: envelope.catalog.ownerGeneration,
            order: [...order],
            inputDigest: historyDigest(JSON.stringify(envelope.payload)),
            decisionDigest: historyDigest(JSON.stringify(order)),
          },
        },
        "{}",
        options.resources,
      );
      committed &&= saved.committed;
      return saved.committed;
    },
    record:
      (envelope: ToolHookEnvelope) =>
      async (item: RecordedHookDecision, resources = options.resources) => {
        const { request, registry } = options;
        const decision = item.decision;
        const effect =
          !item.failed &&
          decision.kind === "external-effect-request" &&
          decision.request.kind === "tool"
            ? decision.request
            : null;
        const available =
          !effect ||
          (registry.resolveByName(effect.name) !== null &&
            options.disclosedToolNames.has(effect.name));
        const effectId =
          effect && available
            ? `hook:${createHash("sha256")
                .update(JSON.stringify([request.invocationId, envelope.point, item.hookId]))
                .digest("hex")}`
            : undefined;
        const saved = await options.history.record(
          options.turnId,
          {
            version: 1,
            type: "gate",
            id: `hook:${historyDigest(JSON.stringify([request.invocationId, envelope.phase, item.hookId, item.execution?.state === "queued" ? "queued" : "decision"]))}`,
            generation: Number(registry.generation),
            invocationId: String(request.invocationId),
            proposalId: request.toolCallId,
            stage: envelope.phase === "pre" ? "pre-hook" : "post-hook",
            decision:
              item.execution?.state === "skipped" || item.execution?.state === "queued"
                ? item.execution.state
                : item.failed
                  ? `failed:${item.failed.reason}`
                  : available
                    ? decision.kind
                    : "external-effect-unavailable",
            declaredEffect: envelope.catalog.payload.declaredEffect,
            cancelled: request.signal.aborted,
            hook: {
              hookId: item.hookId,
              ...(item.evidence ? { failureEvidence: item.evidence } : {}),
              factId: envelope.catalog.factId,
              registrationGeneration: Number(envelope.registrationGeneration),
              inputDigest: historyDigest(JSON.stringify(envelope.payload)),
              decisionDigest: historyDigest(JSON.stringify(decision)),
              ...(item.execution ? { execution: item.execution } : {}),
              ...(effectId ? { effectInvocationId: effectId } : {}),
            },
          },
          "{}",
          resources,
        );
        committed &&= saved.committed;
        if (!available)
          warnings.push({ hookId: item.hookId, reason: "external-effect-unavailable" });
        if (saved.committed && available && effect && effectId)
          options.effects.push({ id: effectId, request: effect });
      },
  };
}
