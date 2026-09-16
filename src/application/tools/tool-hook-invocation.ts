import { createHash } from "node:crypto";
import { canonicalJson, freezeMetadata } from "../../domain/extensions/canonical.ts";
import { HOOK_LIMITS, parseHookEnvelope } from "../../domain/extensions/hook-points.ts";
import { type ClockPort, deadlineAt, instant } from "../../domain/foundation/index.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import {
  type HookHandlerFacts,
  hookHandlerFactsSchema,
  safeHookFailureCode,
} from "../../domain/tools/hook-evidence.ts";
import { validateToolHookDecision } from "../../domain/tools/tool-hook-decision.ts";
import { hookIdentity } from "../../domain/tools/tool-hook-order.ts";
import {
  phaseForHookPoint,
  type RegisteredToolHook,
  type ToolHookDecision,
  type ToolHookEnvelope,
} from "../../domain/tools/tool-hooks.ts";
import { capacityScope, type ProductTaskResources } from "../orchestration/product-resources.ts";

export function snapshotHookEnvelope(envelope: ToolHookEnvelope, registryGeneration: number) {
  let snapshot: ToolHookEnvelope;
  try {
    const catalog = parseHookEnvelope(envelope.catalog);
    if (
      catalog.point !== envelope.point ||
      catalog.registrationGeneration !== Number(envelope.registrationGeneration) ||
      catalog.registrationGeneration !== registryGeneration ||
      catalog.ownerGeneration !== Number(envelope.catalogGeneration) ||
      catalog.subjectId !== String(envelope.invocationId) ||
      catalog.payload.capabilityId !== String(envelope.capabilityId) ||
      catalog.payload.inputDigest !==
        createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex") ||
      envelope.phase !== phaseForHookPoint(envelope.point)
    )
      return { ok: false as const, reason: "hook-envelope-mismatch" };
    canonicalJson(envelope);
    const text = JSON.stringify(envelope);
    if (Buffer.byteLength(text) > HOOK_LIMITS.inputBytes)
      return { ok: false as const, reason: "hook-input-too-large" };
    snapshot = freezeMetadata(JSON.parse(text)) as ToolHookEnvelope;
  } catch {
    return { ok: false as const, reason: "invalid-hook-envelope" };
  }
  return { ok: true as const, snapshot };
}

export class HookExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly cleanup: "complete" | "uncertain" = "complete",
  ) {
    super(code);
  }
}
export type HookInvocationResult = {
  readonly decision?: ToolHookDecision;
  readonly reason?: string;
  readonly cleanup: "complete" | "uncertain" | "not-started";
  readonly handlerFacts?: HookHandlerFacts;
};

/** Own cancellation, late-result fencing and a bounded join for every handler kind. */
export async function invokeHook(input: {
  hook: RegisteredToolHook;
  envelope: ToolHookEnvelope;
  clock: ClockPort;
  expiresAt: number;
  cleanupExpiresAt: number;
  signal: AbortSignal;
  task?: ProductTaskResources;
  onStarted?: () => void;
}): Promise<HookInvocationResult> {
  const { hook, envelope, clock } = input;
  const control = new AbortController();
  const timer = new AbortController();
  const signal = AbortSignal.any([
    input.signal,
    control.signal,
    ...(hook.revoked ? [hook.revoked] : []),
  ]);
  let resourceSignal: AbortSignal | undefined;
  const stopped = () =>
    hook.revoked?.aborted
      ? "revoked"
      : input.signal.aborted
        ? "cancelled"
        : resourceSignal?.aborted && Number(clock.now()) < input.expiresAt
          ? "owner-cancelled"
          : "timed-out";
  if (signal.aborted || Number(clock.now()) >= input.expiresAt)
    return { reason: stopped(), cleanup: "not-started" };
  const snapshot = freezeMetadata({
    ...envelope,
    catalog: {
      ...envelope.catalog,
      remainingMs: Math.max(0, input.expiresAt - Number(clock.now())),
    },
  });
  let active: Promise<HookInvocationResult> | undefined;
  let facts: HookHandlerFacts | undefined;
  let invalidFacts = false;
  let sealed = false;
  const evidence = () => (facts ? { handlerFacts: facts } : {});
  const run = async (ownerSignal: AbortSignal): Promise<HookInvocationResult> => {
    resourceSignal = ownerSignal;
    const combined = AbortSignal.any([signal, ownerSignal]);
    if (combined.aborted) return { reason: stopped(), cleanup: "not-started" };
    input.onStarted?.();
    let finished = false;
    let uncertain = false;
    const called = Promise.resolve()
      .then(() => {
        if (combined.aborted) throw new HookExecutionError(stopped());
        return hook.run(snapshot, {
          signal: combined,
          expiresAt: input.expiresAt,
          resourceTaskId: input.task?.id ?? "builtin-test",
          report(value) {
            if (sealed) return;
            const checked = hookHandlerFactsSchema.safeParse(value);
            const kind = hook.registration?.handler.kind;
            const expected =
              kind === "external-command-v1"
                ? "process"
                : kind === "http-v1" || kind === "mcp-tool-v1"
                  ? "remote"
                  : kind === "prompt-evaluator-v1" || kind === "agent-evaluator-v1"
                    ? "model"
                    : null;
            if (!checked.success || checked.data.kind !== expected) invalidFacts = true;
            else facts = freezeMetadata(checked.data);
          },
        });
      })
      .then(
        (value): HookInvocationResult => {
          if (combined.aborted || Number(clock.now()) >= input.expiresAt)
            return { reason: stopped(), cleanup: "complete" };
          try {
            if (invalidFacts) return { reason: "invalid-handler-evidence", cleanup: "complete" };
            return {
              decision: validateToolHookDecision(value, snapshot, hook.registration),
              cleanup: "complete",
            };
          } catch {
            return { reason: "invalid-hook-decision", cleanup: "complete" };
          }
        },
        (error: unknown): HookInvocationResult => {
          uncertain = error instanceof HookExecutionError && error.cleanup === "uncertain";
          return {
            reason: combined.aborted
              ? stopped()
              : error instanceof HookExecutionError
                ? safeHookFailureCode(error.code)
                : "threw",
            cleanup: uncertain ? "uncertain" : "complete",
          };
        },
      )
      .finally(() => {
        finished = true;
      });
    const deadlineSignal = AbortSignal.any([combined, timer.signal]);
    try {
      const result = await Promise.race([
        called,
        clock
          .waitUntil(instant(input.expiresAt), deadlineSignal)
          .then((): HookInvocationResult => ({ reason: stopped(), cleanup: "uncertain" })),
      ]);
      if (finished) return { ...result, ...evidence() };
      control.abort();
      // Drain may outlive the individual deadline, but never the enclosing chain's cleanup ceiling.
      await Promise.race([
        called,
        clock.waitUntil(
          instant(Math.min(input.cleanupExpiresAt, Number(clock.now()) + 1_000)),
          timer.signal,
        ),
      ]);
      return {
        reason: stopped(),
        cleanup: finished && !uncertain ? "complete" : "uncertain",
        ...evidence(),
      };
    } finally {
      sealed = true;
      timer.abort();
      control.abort();
    }
  };
  if (!input.task) {
    if (hook.registration?.handler.kind !== "builtin")
      return { reason: "hook-resources-unavailable", cleanup: "not-started" };
    return run(signal).catch(() => ({
      reason: "hook-handler-failed",
      cleanup: "uncertain",
      ...evidence(),
    }));
  }
  const identity = `hook:${createHash("sha256")
    .update(JSON.stringify([envelope.invocationId, envelope.phase, hookIdentity(hook)]))
    .digest("hex")}`;
  try {
    const execution = await input.task.execute({
      operation: identity,
      attempt: identity,
      generation: input.task.generation,
      inputBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      amounts:
        hook.registration?.handler.kind === "external-command-v1"
          ? { concurrency: 1, processes: 1, diskBytes: 67_108_864 }
          : { concurrency: 1 },
      ...(hook.registration?.handler.kind === "external-command-v1"
        ? { unknownDimensions: ["cpuMs", "memoryBytes"] as const }
        : {}),
      signal,
      ...(hook.registration?.mode === "async"
        ? {
            scopes: [
              {
                scope: capacityScope(
                  "process",
                  "falryn",
                  `async-hooks:${envelope.catalog.correlation.sessionId ?? "unknown"}`,
                  "concurrency",
                  "occupancy",
                ),
                amount: 1,
                limit: 4,
              },
            ],
          }
        : {}),
      unit: {
        id: workUnitId(identity),
        effect: "observation",
        priority: "interactive",
        conflictKeys: [],
        dependencies: [],
        deadline: deadlineAt(instant(input.expiresAt)),
        expectedOutputBytes: HOOK_LIMITS.responseBytes,
        retry: NO_RETRY,
        scopeId: null,
      },
      async run(ownerSignal) {
        active = run(ownerSignal);
        const result = await active;
        return { value: result, terminated: result.cleanup !== "uncertain" };
      },
    });
    if (active) return await active;
    return execution.kind === "completed"
      ? execution.value
      : { reason: `hook-admission-${execution.receipt.state}`, cleanup: "not-started" };
  } catch {
    return {
      reason: "hook-admission-failed",
      cleanup: active ? "uncertain" : "not-started",
      ...evidence(),
    };
  } finally {
    sealed = true;
    timer.abort();
    control.abort();
  }
}
