/**
 * Run built-in tool hooks at capability-invocation points (#53).
 *
 * Never executes tools. Never imports plugin packages. Timeouts and throws
 * follow the hook point's fail-closed / fail-open posture.
 */

import {
  addDuration,
  type ClockPort,
  DEFAULT_TOOL_HOOK_TIMEOUT_MS,
  duration,
  failurePostureForHookPoint,
  hooksForPoint,
  type Instant,
  isRecursionDenied,
  MAX_TOOL_HOOK_TIMEOUT_MS,
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
} from "../domain/index.ts";

export type ToolHookRunnerOptions = {
  readonly clock: ClockPort;
  readonly registry: ToolHookRegistry;
  readonly timeoutMs?: number;
  readonly onFact?: (fact: ToolLifecycleFact) => void;
};

export type RunToolHooksInput = {
  readonly envelope: ToolHookEnvelope;
  readonly signal: AbortSignal;
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

function timeoutMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isSafeInteger(requested) || requested < 1) {
    return DEFAULT_TOOL_HOOK_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_TOOL_HOOK_TIMEOUT_MS);
}

type HookInvokeResult =
  | { readonly ok: true; readonly decision: RecordedHookDecision["decision"] }
  | { readonly ok: false; readonly reason: string };

async function invokeHook(
  run: ToolHookRegistry["hooks"][number]["run"],
  envelope: ToolHookEnvelope,
  clock: ClockPort,
  budgetMs: number,
  signal: AbortSignal,
): Promise<HookInvokeResult> {
  const expiresAt = addDuration(clock.now(), duration(budgetMs));
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    controller.abort();
  }
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => run(envelope))
        .then((decision) => ({ ok: true, decision }) as const),
      clock
        .waitUntil(expiresAt, controller.signal)
        .then((outcome) =>
          outcome === "reached"
            ? ({ ok: false, reason: "timed-out" } as const)
            : ({ ok: false, reason: "cancelled" } as const),
        ),
    ]);
    return result;
  } catch {
    return { ok: false, reason: "threw" };
  } finally {
    controller.abort();
    signal.removeEventListener("abort", onAbort);
  }
}

export function createToolHookRunner(options: ToolHookRunnerOptions): ToolHookRunner {
  const budget = timeoutMs(options.timeoutMs);
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
    for (const hook of hooksForPoint(options.registry, point)) {
      const result = await invokeHook(
        hook.run,
        input.envelope,
        options.clock,
        budget,
        input.signal,
      );
      if (!result.ok) {
        recorded.push({
          hookId: hook.id,
          decision: { kind: "allow" },
          failed: { reason: result.reason },
        });
        emit({
          kind: "hook-decided",
          at: at(),
          point,
          invocationId: input.envelope.invocationId,
          hookId: hook.id,
          decisionKind: "failed",
        });
        if (failurePostureForHookPoint(point) === "fail-closed") {
          break;
        }
        continue;
      }
      recorded.push({ hookId: hook.id, decision: result.decision });
      emit({
        kind: "hook-decided",
        at: at(),
        point,
        invocationId: input.envelope.invocationId,
        hookId: hook.id,
        decisionKind: result.decision.kind,
      });
      if (result.decision.kind === "deny" && phaseForHookPoint(point) === "pre") {
        break;
      }
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
