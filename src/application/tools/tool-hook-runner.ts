import { matchesHookFilters } from "../../domain/extensions/hook-filters.ts";
import { type HookBudgetClass, hookBudgetClass } from "../../domain/extensions/hook-handlers.ts";
import { HOOK_BUDGETS } from "../../domain/extensions/hook-points.ts";
import { hookIdentity } from "../../domain/tools/tool-hook-order.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import { invokeHook, snapshotHookEnvelope } from "./tool-hook-invocation.ts";
import { admitHookObserver } from "./tool-hook-observers.ts";
/**
 * Run built-in tool hooks at capability-invocation points (#53).
 *
 * Never executes tools. Never imports plugin packages. Timeouts and throws
 * follow the hook point's fail-closed / fail-open posture.
 */

import type { ClockPort, Instant } from "../../domain/foundation/index.ts";
import {
  failurePostureForHookPoint,
  hooksForPoint,
  isRecursionDenied,
  type PostHookSettlement,
  type PreHookSettlement,
  phaseForHookPoint,
  type RecordedHookDecision,
  settlePostHookDecisions,
  settlePreHookDecisions,
  type ToolHookEnvelope,
  type ToolHookPoint,
  type ToolHookRegistry,
  type ToolLifecycleFact,
} from "../../domain/tools/index.ts";

export type ToolHookRunnerOptions = {
  readonly clock: ClockPort;
  readonly registry: ToolHookRegistry;
  readonly timeoutMs?: number;
  readonly onFact?: (fact: ToolLifecycleFact) => void;
};

export type HookChainBudget = { startedAt: number; spent: Record<HookBudgetClass, number> };

export type RunToolHooksInput = {
  readonly budget?: HookChainBudget;
  readonly envelope: ToolHookEnvelope;
  readonly signal: AbortSignal;
  readonly onDecision?: (
    decision: RecordedHookDecision,
    resources?: ProductTaskResources,
  ) => Promise<void>;
  readonly onPlan?: (order: readonly string[]) => Promise<boolean>;
  readonly task?: ProductTaskResources;
  readonly resourceOwner?: object;
};

export type PreHookRunResult =
  | PreHookSettlement
  | { readonly kind: "transform-conflict"; readonly key: string }
  | { readonly kind: "recursion-denied" };

export type PostHookRunResult =
  | PostHookSettlement
  | { readonly kind: "illegal-rewrite"; readonly hookId: string }
  | { readonly kind: "recursion-denied" };

export type ToolHookRunner = {
  runPre(input: RunToolHooksInput): Promise<PreHookRunResult>;
  runPost(input: RunToolHooksInput): Promise<PostHookRunResult>;
};

export function createToolHookRunner(options: ToolHookRunnerOptions): ToolHookRunner {
  const emit = (fact: ToolLifecycleFact): void => {
    options.onFact?.(fact);
  };

  const runPoint = async (
    point: ToolHookPoint,
    input: RunToolHooksInput,
  ): Promise<readonly RecordedHookDecision[]> => {
    const at = (): Instant => options.clock.now();
    emit({
      kind: "hook-point-entered",
      at: at(),
      point,
      invocationId: input.envelope.invocationId,
    });
    const recorded: RecordedHookDecision[] = [];
    const hooks = hooksForPoint(options.registry, point);
    const checked = snapshotHookEnvelope(input.envelope, Number(options.registry.generation));
    if (!checked.ok)
      return [
        { hookId: "runner", decision: { kind: "allow" }, failed: { reason: checked.reason } },
      ];
    if (hooks.length && input.onPlan && !(await input.onPlan(hooks.map(hookIdentity))))
      return [
        {
          hookId: "runner",
          decision: { kind: "allow" },
          failed: { reason: "hook-plan-unavailable" },
        },
      ];
    const envelope = checked.snapshot;
    const started = input.budget?.startedAt ?? Number(at());
    const expiresAt = Math.min(
      started + HOOK_BUDGETS.mixedChainMs,
      envelope.deadline?.expiresAt ?? Number.POSITIVE_INFINITY,
      input.task?.expiresAt ?? Number.POSITIVE_INFINITY,
    );
    const spent = input.budget?.spent ?? { local: 0, remote: 0, evaluator: 0 };
    for (const [position, hook] of hooks.entries()) {
      const registration = hook.registration;
      if (!registration) throw new Error("unvalidated hook registry");
      const id = hookIdentity(hook);
      const budgetClass = hookBudgetClass(registration.handler);
      const limits = HOOK_BUDGETS[budgetClass];
      const began = Number(at());
      const cleanupExpiresAt = Math.min(expiresAt, began + limits.chainMs - spent[budgetClass]);
      const deadline = Math.min(
        cleanupExpiresAt,
        began +
          Math.min(
            limits.maximumMs,
            registration.timeoutMs ?? options.timeoutMs ?? limits.defaultMs,
          ),
      );
      const execution = (
        state: NonNullable<RecordedHookDecision["execution"]>["state"],
        cleanup: NonNullable<RecordedHookDecision["execution"]>["cleanup"],
      ) => ({
        position,
        state,
        cleanup,
        elapsedMs: Math.max(0, Number(at()) - began),
      });
      const publish = async (record: RecordedHookDecision, task = input.task) => {
        await input.onDecision?.(record, task);
        emit({
          kind: "hook-decided",
          at: at(),
          point,
          invocationId: envelope.invocationId,
          hookId: id,
          decisionKind: record.failed ? "failed" : record.decision.kind,
        });
      };
      if (!matchesHookFilters(registration, envelope.catalog)) {
        const skipped: RecordedHookDecision = {
          hookId: id,
          decision: { kind: "allow" },
          execution: execution("skipped", "not-started"),
        };
        recorded.push(skipped);
        await publish(skipped);
        continue;
      }
      const run = async (
        task = input.task,
        onStarted?: () => void,
      ): Promise<RecordedHookDecision> => {
        const result = await invokeHook({
          hook,
          envelope,
          clock: options.clock,
          expiresAt: deadline,
          cleanupExpiresAt,
          signal: input.signal,
          ...(onStarted ? { onStarted } : {}),
          ...(task ? { task } : {}),
        });
        if (registration.mode !== "async") spent[budgetClass] += Math.max(0, Number(at()) - began);
        return {
          hookId: id,
          decision: result.decision ?? { kind: "allow" },
          ...(result.reason ? { failed: { reason: result.reason } } : {}),
          execution: execution(
            result.cleanup === "not-started" ? "not-started" : "settled",
            result.cleanup,
          ),
        };
      };
      if (registration.mode === "async") {
        const reservedMs = Math.max(0, Math.min(cleanupExpiresAt, deadline + 1_000) - began);
        spent[budgetClass] += reservedMs;
        const admitted = admitHookObserver({
          owner: input.resourceOwner,
          task: input.task,
          session: envelope.catalog.correlation.sessionId ?? "unknown",
          payloadBytes: Buffer.byteLength(JSON.stringify(envelope)),
          run: async (task, started) => {
            await publish(await run(task, started), task);
          },
          failed: () =>
            emit({
              kind: "hook-decided",
              at: at(),
              point,
              invocationId: envelope.invocationId,
              hookId: id,
              decisionKind: "failed",
            }),
        });
        if (!admitted) spent[budgetClass] -= reservedMs;
        const record: RecordedHookDecision = {
          hookId: id,
          decision: { kind: "allow" },
          execution: execution(admitted ? "queued" : "dropped", "not-started"),
          ...(admitted ? {} : { failed: { reason: "hook-observer-unavailable" } }),
        };
        recorded.push(record);
        try {
          await publish(record);
          admitted?.start();
        } catch (error) {
          admitted?.cancel();
          throw error;
        }
        continue;
      }
      const record = await run();
      recorded.push(record);
      await publish(record);
      if (
        (record.failed && failurePostureForHookPoint(point) === "fail-closed") ||
        ((record.decision.kind === "deny" || record.decision.kind === "veto") &&
          phaseForHookPoint(point) === "pre")
      )
        break;
    }
    return recorded;
  };

  return {
    async runPre(input) {
      if (input.envelope.point !== "before-capability-invocation") {
        return { kind: "failed-closed", reason: "wrong-point", hookId: "runner" };
      }
      if (isRecursionDenied(input.envelope)) {
        emit({
          kind: "hook-point-settled",
          at: options.clock.now(),
          point: "before-capability-invocation",
          invocationId: input.envelope.invocationId,
          settlement: "recursion-denied",
        });
        return { kind: "recursion-denied" };
      }
      const recorded = await runPoint("before-capability-invocation", input);
      const settlement = settlePreHookDecisions(recorded);
      emit({
        kind: "hook-point-settled",
        at: options.clock.now(),
        point: "before-capability-invocation",
        invocationId: input.envelope.invocationId,
        settlement: settlement.kind,
      });
      return settlement;
    },
    async runPost(input) {
      if (input.envelope.point !== "after-capability-invocation") {
        return { kind: "illegal-rewrite", hookId: "runner" };
      }
      if (isRecursionDenied(input.envelope)) {
        emit({
          kind: "hook-point-settled",
          at: options.clock.now(),
          point: "after-capability-invocation",
          invocationId: input.envelope.invocationId,
          settlement: "recursion-denied",
        });
        return { kind: "recursion-denied" };
      }
      const recorded = await runPoint("after-capability-invocation", input);
      const settlement = settlePostHookDecisions(recorded);
      emit({
        kind: "hook-point-settled",
        at: options.clock.now(),
        point: "after-capability-invocation",
        invocationId: input.envelope.invocationId,
        settlement: settlement.kind,
      });
      return settlement;
    },
  };
}
