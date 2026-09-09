/** One product admission owner, shared by tools and provider requests in this process. */
import { createHash, randomUUID } from "node:crypto";
import {
  type ClockPort,
  createSystemClock,
  deadlineAt,
  instant,
} from "../../domain/foundation/index.ts";
import type { ChildWorkTarget } from "../../domain/orchestration/child-admission.ts";
import type { EffectCertainty } from "../../domain/orchestration/outcome.ts";
import type {
  ResourceAdmissionReceipt,
  ResourceAmounts,
  ResourceDebit,
  ResourceDimension,
  ResourceReservationIdentityV1,
  SharedCapacityScopeIdentityV1,
} from "../../domain/orchestration/resource-admission.ts";
import {
  canonicalResourceValue,
  resourceAmountsSchema,
} from "../../domain/orchestration/resource-admission.ts";
import {
  type EffectClass,
  effectiveConflictKeys,
  type WorkUnit,
} from "../../domain/orchestration/work.ts";
import { createResourceLedger } from "./resource-ledger.ts";
import { createResourceLifetime } from "./resource-lifetime.ts";
import { createScheduler } from "./scheduler.ts";
import { MAX_SCOPE_DEPTH } from "./scope-tree.ts";

// Only the existing child allocation can mark a later segment as retained work.
// Root callers and serialized requests cannot acquire this continuation authority.
const retainedChildSegments = new WeakMap<object, string>();

/** Occupancy is released only after authoritative termination, at every depth. */
function bucketKind(dimension: ResourceDimension) {
  return [
    "memoryBytes",
    "bufferedBytes",
    "bufferedItems",
    "processes",
    "descendants",
    "concurrency",
  ].includes(dimension)
    ? ("occupancy" as const)
    : ("cumulative" as const);
}

export type ResourceExecution<Value> =
  | {
      readonly kind: "completed";
      readonly value: Value;
      readonly receipt: ResourceAdmissionReceipt;
    }
  | { readonly kind: "stopped" | "replayed"; readonly receipt: ResourceAdmissionReceipt };
export type ResourceWork<Value> = {
  readonly target?: ChildWorkTarget;
  /** Synchronous owner checks repeated immediately before acquiring capacity. */
  readonly checkAdmission?: () => ResourceAdmissionReceipt | null;
  readonly operation: string;
  readonly attempt: string;
  readonly generation: string;
  readonly unit: WorkUnit;
  readonly inputBytes: number;
  readonly amounts: ResourceAmounts;
  readonly unknownDimensions?: readonly ResourceDimension[];
  readonly scopes?: readonly ResourceDebit[];
  readonly signal: AbortSignal;
  /** Child scopes supply their whole ancestor lifetime for an early receipt. */
  readonly retain?: () => (() => void) | null;
  /** Publish a committed control receipt while this same execution retains its reservations. */
  run(
    signal: AbortSignal,
    publish: (value: Value) => boolean,
  ): Promise<{
    readonly value: Value;
    readonly actual?: ResourceAmounts;
    readonly observedEffect?: EffectCertainty;
    readonly terminated: boolean;
  }>;
};
export type ProductTaskResources = {
  childIdentity(id: string, workDigest: string): "available" | "duplicate-child" | "no-progress";
  checkAuthority(target: ChildWorkTarget, effect: EffectClass): ResourceAdmissionReceipt | null;
  readonly id: string;
  readonly generation: string;
  readonly expiresAt: number;
  refusal(
    state: ResourceAdmissionReceipt["state"],
    dimension?: ResourceDimension,
  ): ResourceAdmissionReceipt;
  remaining(dimension: ResourceDimension): number;
  tighten(limits: ResourceAmounts): boolean;
  execute<Value>(work: ResourceWork<Value>): Promise<ResourceExecution<Value>>;
  subdivide(
    limits: ResourceAmounts,
    identity?: { readonly id: string; readonly workDigest: string },
  ): ProductTaskResources | null;
  /** Hold existing execution through caller close; grants no new execution authority. */
  retain(): (() => void) | null;
  onClose(listener: () => void): (() => void) | null;
  close(): void;
};
export type ProductResources = ReturnType<typeof createProductResources>;
export function capacityScope(
  ownerKind: SharedCapacityScopeIdentityV1["ownerKind"],
  destination: string,
  family: string,
  dimension: ResourceDimension,
  bucketKind: SharedCapacityScopeIdentityV1["bucketKind"] = "cumulative",
  workspace?: string,
): SharedCapacityScopeIdentityV1 {
  return {
    version: 1,
    ownerKind,
    destination,
    family,
    dimension,
    bucketKind,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

export function createProductResources(
  clock: ClockPort,
  options: { readonly maxConcurrent?: number; readonly maxTasks?: number } = {},
) {
  const ledger = createResourceLedger();
  const maxConcurrent = options.maxConcurrent ?? 16;
  const shutdown = new AbortController();
  const scheduler = createScheduler<void>({
    clock,
    capacityChanges: ledger,
    limits: {
      maxConcurrent,
      maxConcurrentPerKey: 1,
      reservedInteractive: 1,
      maxQueued: 64,
      maxQueuedBytes: 16 * 1024 * 1024,
      lockAcquisitionTimeoutMs: 30_000,
      starvationThreshold: 8,
    },
  });
  const tasks = new Map<string, { expiresAt: number; close(): void }>();
  return {
    openTask(generation: string, requested: ResourceAmounts = {}): ProductTaskResources {
      if (!resourceAmountsSchema.safeParse(requested).success)
        throw new Error("invalid task resource limits");
      for (const task of tasks.values()) if (clock.now() >= task.expiresAt) task.close();
      const id = randomUUID();
      const denied = tasks.size >= (options.maxTasks ?? 256);
      let closed = denied;
      let overrun = false;
      const unknownUsage = new Set<ResourceDimension>();
      const cancellation = new AbortController();
      const limits: ResourceAmounts = {
        ...requested,
        operations: Math.min(512, requested.operations ?? 512),
        requests: Math.min(64, requested.requests ?? 64),
        wallTimeMs: Math.min(30 * 60_000, requested.wallTimeMs ?? 30 * 60_000),
      };
      const currentLimits = { ...limits };
      const startedAt = Number(clock.now());
      const expiresAt = startedAt + (limits.wallTimeMs ?? 30 * 60_000);
      const taskScope = (dimension: ResourceDimension) =>
        capacityScope("task", id, "whole-task", dimension, bucketKind(dimension));
      let subdivisions = 0;
      const childIds = new Set<string>();
      const childWork = new Set<string>();
      const childIdentity: ProductTaskResources["childIdentity"] = (id, digest) =>
        childIds.has(id) ? "duplicate-child" : childWork.has(digest) ? "no-progress" : "available";
      const claimChild = (
        identity?: { readonly id: string; readonly workDigest: string },
        retained = false,
      ) => {
        if (
          closed ||
          (!lifetime.accepting() && !retained) ||
          shutdown.signal.aborted ||
          subdivisions >= 64
        )
          return false;
        if (identity && childIdentity(identity.id, identity.workDigest) !== "available")
          return false;
        subdivisions++;
        if (identity) {
          childIds.add(identity.id);
          childWork.add(identity.workDigest);
        }
        return true;
      };
      const replays = new Map<
        string,
        {
          fingerprint: string;
          result: Promise<{
            readonly kind: "replayed";
            readonly receipt: ResourceAdmissionReceipt;
          }>;
        }
      >();
      const stoppedReceipt = (
        state: ResourceAdmissionReceipt["state"],
      ): ResourceAdmissionReceipt => ({
        version: 1,
        state,
        reservation: id,
        scope: null,
        dimension: null,
        acquired: false,
        released: false,
        uncertain: false,
        queuePosition: null,
        deadline: expiresAt,
      });
      const lifetime = createResourceLifetime(() => {
        closed = true;
        cancellation.abort();
        tasks.delete(id);
        replays.clear();
        ledger.closeTask(id);
      });
      const close = lifetime.close;
      const task: ProductTaskResources = {
        childIdentity,
        checkAuthority: () => null,
        subdivide(narrower, identity) {
          if (
            !lifetime.accepting() ||
            !resourceAmountsSchema.safeParse(narrower).success ||
            !claimChild(identity)
          )
            return null;
          return childTask(
            task,
            narrower,
            clock,
            ledger,
            1,
            claimChild,
            unknownUsage,
            id,
            lifetime.accepting,
            () => {
              if (closed || shutdown.signal.aborted || task.remaining("wallTimeMs") === 0)
                return null;
              return lifetime.retainExisting();
            },
          );
        },
        id,
        generation,
        expiresAt,
        close,
        onClose: lifetime.onClose,
        retain() {
          if (closed || shutdown.signal.aborted || task.remaining("wallTimeMs") === 0) return null;
          return lifetime.retain();
        },
        refusal(state, dimension) {
          return { ...stoppedReceipt(state), dimension: dimension ?? null };
        },
        remaining(dimension) {
          if (closed || overrun || shutdown.signal.aborted) return 0;
          if (dimension === "wallTimeMs")
            return Math.max(0, startedAt + (currentLimits.wallTimeMs ?? 0) - Number(clock.now()));
          return ledger.remaining(
            taskScope(dimension),
            currentLimits[dimension] ?? Number.MAX_SAFE_INTEGER,
          );
        },
        tighten(narrower) {
          if (closed || !resourceAmountsSchema.safeParse(narrower).success) return false;
          for (const [dimension, limit] of Object.entries(narrower)) {
            const key = dimension as ResourceDimension;
            currentLimits[key] = Math.min(currentLimits[key] ?? Number.MAX_SAFE_INTEGER, limit);
            ledger.narrow(taskScope(key), currentLimits[key], id);
          }
          return true;
        },
        execute<Value>(work: ResourceWork<Value>): Promise<ResourceExecution<Value>> {
          const refuse = (state: ResourceAdmissionReceipt["state"]) =>
            Promise.resolve<ResourceExecution<Value>>({
              kind: "stopped",
              receipt: stoppedReceipt(state),
            });
          if (shutdown.signal.aborted) return refuse("shutdown");
          if (
            closed ||
            (!lifetime.accepting() && retainedChildSegments.get(work) !== id) ||
            work.generation !== generation
          )
            return refuse("stale-generation");
          if (work.signal.aborted) return refuse("cancelled");
          if (overrun) return refuse("limit-exceeded");
          if ([...unknownUsage].some((dimension) => currentLimits[dimension] !== undefined))
            return refuse("quota-unknown");
          if (task.remaining("wallTimeMs") === 0) return refuse("admission-timeout");
          if (!resourceAmountsSchema.safeParse(work.amounts).success)
            return refuse("quota-unknown");
          const earlyRefusal = work.checkAdmission?.();
          if (earlyRefusal) return Promise.resolve({ kind: "stopped", receipt: earlyRefusal });
          if (
            (work.unknownDimensions ?? []).some(
              (dimension) =>
                currentLimits[dimension] !== undefined ||
                work.scopes?.some(
                  (debit) =>
                    debit.scope.dimension === dimension && debit.limit < Number.MAX_SAFE_INTEGER,
                ),
            )
          )
            return refuse("quota-unknown");
          const amounts = {
            ...work.amounts,
            operations: 1,
            concurrency: Math.max(1, work.amounts.concurrency ?? 1),
          };
          const debits: ResourceDebit[] = [
            ...effectiveConflictKeys(work.unit).map((key) => ({
              scope: capacityScope(
                "process",
                "falryn",
                `conflict:${createHash("sha256").update(key).digest("hex")}`,
                "concurrency",
                "occupancy",
              ),
              amount: 1,
              limit: 1,
            })),
            {
              scope: capacityScope("process", "falryn", "product", "concurrency", "occupancy"),
              amount: 1,
              limit: maxConcurrent,
            },
            ...Object.entries(amounts).map(([dimension, amount]) => ({
              scope: taskScope(dimension as ResourceDimension),
              amount,
              limit: currentLimits[dimension as ResourceDimension] ?? Number.MAX_SAFE_INTEGER,
            })),
            ...(work.scopes ?? []),
          ];
          const reservation = createHash("sha256")
            .update(canonicalResourceValue([id, work.attempt, work.operation]))
            .digest("hex");
          const identity: ResourceReservationIdentityV1 = {
            version: 1,
            parentScope: id,
            owner: id,
            operation: work.operation,
            workspaceGeneration: generation,
            configurationGeneration: generation,
            attempt: work.attempt,
            fence: id,
            scopes: debits.map((debit) => debit.scope),
          };
          const fingerprint = canonicalResourceValue({
            identity,
            amounts,
            debits,
            unit: work.unit,
            inputBytes: work.inputBytes,
            unknownDimensions: work.unknownDimensions,
            target: work.target,
          });
          const previous = replays.get(reservation);
          if (previous !== undefined) {
            if (previous.fingerprint !== fingerprint) return refuse("stale-generation");
            return previous.result;
          }
          if (replays.size >= 512) return refuse("limit-exceeded");
          const early = Promise.withResolvers<ResourceExecution<Value>>();
          let published = false;
          let release: (() => void) | null = null;
          let workFinished = false;
          let schedulerFinished = false;
          const releaseWhenFinished = () => {
            if (workFinished && schedulerFinished) release?.();
          };
          const run = async (): Promise<ResourceExecution<Value>> => {
            let acquired = false;
            let receipt = stoppedReceipt("queued");
            let completion: { value: Value } | undefined;
            const signal = AbortSignal.any([work.signal, shutdown.signal, cancellation.signal]);
            const deadline = Math.min(
              work.unit.deadline?.expiresAt ?? Number.POSITIVE_INFINITY,
              Number(clock.now()) + task.remaining("wallTimeMs"),
            );
            const [result] = await scheduler.schedule(
              [
                {
                  unit: { ...work.unit, deadline: deadlineAt(instant(deadline)) },
                  inputBytes: work.inputBytes,
                  admit() {
                    const refusal = work.checkAdmission?.();
                    if (refusal) return { kind: "refused", receipt: refusal };
                    if (closed || work.generation !== generation)
                      return { kind: "refused", receipt: stoppedReceipt("stale-generation") };
                    if (task.remaining("wallTimeMs") === 0)
                      return { kind: "refused", receipt: stoppedReceipt("admission-timeout") };
                    const admission = ledger.reserve(
                      reservation,
                      identity,
                      debits.map((debit) =>
                        debit.scope.ownerKind === "task"
                          ? {
                              ...debit,
                              limit: Math.min(
                                debit.limit,
                                currentLimits[debit.scope.dimension] ?? Number.MAX_SAFE_INTEGER,
                              ),
                            }
                          : debit,
                      ),
                    );
                    receipt = {
                      ...admission.receipt,
                      deadline,
                      queuePosition: admission.kind === "queued" ? scheduler.report().queued : null,
                    };
                    if (admission.kind === "queued") return { kind: "wait" };
                    if (admission.kind !== "admitted") return { kind: "refused", receipt };
                    acquired = true;
                    return { kind: "ready" };
                  },
                  async run(context) {
                    for (const dimension of work.unknownDimensions ?? [])
                      unknownUsage.add(dimension);
                    try {
                      const outcome = await work.run(context.signal, (value) => {
                        if (published || context.signal.aborted) return false;
                        release = (work.retain ?? task.retain)();
                        if (release === null) return false;
                        published = true;
                        early.resolve({ kind: "completed", value, receipt });
                        return true;
                      });
                      const actual =
                        outcome.actual === undefined
                          ? null
                          : debits.map((debit) => ({
                              ...debit,
                              amount:
                                debit.scope.ownerKind === "task" ||
                                debit.scope.ownerKind === "agent"
                                  ? ["operations", "requests", "attempts", "retries"].includes(
                                      debit.scope.dimension,
                                    )
                                    ? Math.max(
                                        debit.amount,
                                        outcome.actual?.[debit.scope.dimension] ?? debit.amount,
                                      )
                                    : (outcome.actual?.[debit.scope.dimension] ?? debit.amount)
                                  : debit.amount,
                            }));
                      receipt =
                        ledger.settle(reservation, actual, outcome.terminated) ??
                        ledger.settle(reservation, null, false) ??
                        receipt;
                      if (receipt.state === "limit-exceeded") overrun = true;
                      completion = { value: outcome.value };
                    } catch {
                      receipt = ledger.settle(reservation, null, false) ?? receipt;
                      throw new Error("admitted operation failed without termination evidence");
                    } finally {
                      workFinished = true;
                      releaseWhenFinished();
                      if (closed) ledger.closeTask(id);
                    }
                  },
                },
              ],
              signal,
            );
            if (result?.kind === "completed" && completion !== undefined)
              return { kind: "completed", value: completion.value, receipt };
            if (acquired) receipt = ledger.settle(reservation, null, false) ?? receipt;
            else if (result?.kind === "refused" && result.error.code === "resource-admission")
              receipt = result.error.receipt;
            else
              receipt = {
                ...receipt,
                state: shutdown.signal.aborted
                  ? "shutdown"
                  : signal.aborted
                    ? "cancelled"
                    : result?.kind === "refused" && result.error.code === "queue-limit"
                      ? "limit-exceeded"
                      : "admission-timeout",
                queuePosition: null,
              };
            return { kind: "stopped", receipt };
          };
          const result = run().finally(() => {
            schedulerFinished = true;
            releaseWhenFinished();
          });
          replays.set(reservation, {
            fingerprint,
            result: result.then((settled) => ({ kind: "replayed", receipt: settled.receipt })),
          });
          return Promise.race([result, early.promise]);
        },
      };
      if (!denied) tasks.set(id, { expiresAt, close });
      return task;
    },
    shutdown() {
      shutdown.abort();
      for (const task of tasks.values()) task.close();
    },
    report() {
      return { ...ledger.report(), tasks: tasks.size, scheduler: scheduler.report() };
    },
    ledger,
  };
}

/** Child scopes add debits to the same transaction; they never create a new parent allowance. */
function childTask(
  parent: ProductTaskResources,
  initial: ResourceAmounts,
  clock: ClockPort,
  ledger: ReturnType<typeof createResourceLedger>,
  depth: number,
  claimChild: (
    identity?: { readonly id: string; readonly workDigest: string },
    retained?: boolean,
  ) => boolean,
  unknownUsage: ReadonlySet<ResourceDimension>,
  rootId: string,
  parentAccepting: () => boolean,
  retainParent: () => (() => void) | null,
): ProductTaskResources {
  const id = randomUUID();
  let limits = { ...initial };
  let closed = false;
  let children = 0;
  const stop = new AbortController();
  const started = Number(clock.now());
  const scope = (dimension: ResourceDimension) =>
    capacityScope("agent", id, "child", dimension, bucketKind(dimension));
  const lifetime = createResourceLifetime(() => {
    closed = true;
    stop.abort();
  });
  const canContinue = () => parentAccepting() || lifetime.retained();
  const child: ProductTaskResources = {
    childIdentity: (id, digest) => parent.childIdentity(id, digest),
    checkAuthority: (target, effect) => parent.checkAuthority(target, effect),
    id,
    refusal(state, dimension) {
      return parent.refusal(state, dimension);
    },
    generation: parent.generation,
    expiresAt: Math.min(parent.expiresAt, started + (limits.wallTimeMs ?? Number.MAX_SAFE_INTEGER)),
    retain() {
      if (closed || !lifetime.accepting() || !canContinue() || child.remaining("wallTimeMs") === 0)
        return null;
      const releaseParent = retainParent();
      if (releaseParent === null) return null;
      const releaseChild = lifetime.retain();
      if (releaseChild === null) {
        releaseParent();
        return null;
      }
      return () => {
        releaseChild();
        releaseParent();
      };
    },
    remaining(dimension) {
      if (closed) return 0;
      const own =
        dimension === "wallTimeMs"
          ? Math.max(
              0,
              started + (limits.wallTimeMs ?? Number.MAX_SAFE_INTEGER) - Number(clock.now()),
            )
          : ledger.remaining(scope(dimension), limits[dimension] ?? Number.MAX_SAFE_INTEGER);
      return Math.min(parent.remaining(dimension), own);
    },
    tighten(narrower) {
      if (closed || !resourceAmountsSchema.safeParse(narrower).success) return false;
      limits = Object.fromEntries(
        Object.entries({ ...limits, ...narrower }).map(([name, value]) => [
          name,
          Math.min(value, limits[name as ResourceDimension] ?? Number.MAX_SAFE_INTEGER),
        ]),
      );
      for (const [name, value] of Object.entries(limits))
        ledger.narrow(scope(name as ResourceDimension), value, rootId);
      return true;
    },
    execute<Value>(work: ResourceWork<Value>) {
      const retainedDescendant = retainedChildSegments.get(work) === rootId && lifetime.retained();
      if ((!lifetime.accepting() && !retainedDescendant) || !canContinue())
        return Promise.resolve({
          kind: "stopped" as const,
          receipt: parent.refusal("stale-generation"),
        });
      if ([...unknownUsage].some((dimension) => limits[dimension] !== undefined))
        return Promise.resolve({
          kind: "stopped" as const,
          receipt: parent.refusal("quota-unknown"),
        });
      const amounts = {
        ...work.amounts,
        operations: 1,
        concurrency: Math.max(1, work.amounts.concurrency ?? 1),
      };
      const segment: ResourceWork<Value> = {
        ...work,
        checkAdmission() {
          if ((!lifetime.accepting() && !retainedDescendant) || !canContinue())
            return child.refusal("stale-generation");
          if (child.remaining("wallTimeMs") === 0)
            return child.refusal("admission-timeout", "wallTimeMs");
          if ([...unknownUsage].some((dimension) => limits[dimension] !== undefined))
            return child.refusal("quota-unknown");
          return work.checkAdmission?.() ?? null;
        },
        retain: work.retain ?? (() => child.retain()),
        operation: createHash("sha256")
          .update(canonicalResourceValue([id, work.operation]))
          .digest("hex"),
        signal: AbortSignal.any([work.signal, stop.signal]),
        unit: {
          ...work.unit,
          deadline: deadlineAt(
            instant(
              Math.min(
                work.unit.deadline?.expiresAt ?? Number.MAX_SAFE_INTEGER,
                Number(clock.now()) + child.remaining("wallTimeMs"),
              ),
            ),
          ),
        },
        scopes: [
          ...(work.scopes ?? []),
          ...((work.scopes ?? []).some(
            (debit) =>
              debit.scope.family === "child-runnable" && debit.scope.destination === rootId,
          )
            ? []
            : [
                {
                  scope: capacityScope(
                    "task",
                    rootId,
                    "child-runnable",
                    "concurrency",
                    "occupancy",
                  ),
                  amount: 1,
                  limit: 4,
                },
              ]),
          ...Object.keys(limits)
            .filter((dimension) => !(dimension in amounts))
            .map((dimension) => ({
              scope: scope(dimension as ResourceDimension),
              amount: 0,
              limit: limits[dimension as ResourceDimension] ?? 0,
            })),
          ...Object.entries(amounts).map(([dimension, amount]) => ({
            scope: scope(dimension as ResourceDimension),
            amount,
            limit: limits[dimension as ResourceDimension] ?? Number.MAX_SAFE_INTEGER,
          })),
        ],
      };
      retainedChildSegments.set(segment, rootId);
      return parent.execute(segment);
    },
    subdivide(narrower, identity) {
      if (
        closed ||
        !lifetime.accepting() ||
        !canContinue() ||
        depth >= MAX_SCOPE_DEPTH ||
        children >= 64 ||
        !resourceAmountsSchema.safeParse(narrower).success ||
        !claimChild(identity, canContinue())
      )
        return null;
      children++;
      return childTask(
        child,
        narrower,
        clock,
        ledger,
        depth + 1,
        claimChild,
        unknownUsage,
        rootId,
        canContinue,
        () => child.retain(),
      );
    },
    close: lifetime.close,
    onClose: lifetime.onClose,
  };
  return child;
}

/** Module lifetime is the process lifetime; callers may inject an isolated owner in tests. */
export const processProductResources = createProductResources(createSystemClock());
