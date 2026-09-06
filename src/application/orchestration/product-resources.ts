/** One product admission owner, shared by tools and provider requests in this process. */
import { createHash, randomUUID } from "node:crypto";
import {
  type ClockPort,
  createSystemClock,
  deadlineAt,
  instant,
} from "../../domain/foundation/index.ts";
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
import { effectiveConflictKeys, type WorkUnit } from "../../domain/orchestration/work.ts";
import { createResourceLedger } from "./resource-ledger.ts";
import { createScheduler } from "./scheduler.ts";

export type ResourceExecution<Value> =
  | {
      readonly kind: "completed";
      readonly value: Value;
      readonly receipt: ResourceAdmissionReceipt;
    }
  | { readonly kind: "stopped" | "replayed"; readonly receipt: ResourceAdmissionReceipt };
export type ResourceWork<Value> = {
  readonly operation: string;
  readonly attempt: string;
  readonly generation: string;
  readonly unit: WorkUnit;
  readonly inputBytes: number;
  readonly amounts: ResourceAmounts;
  readonly unknownDimensions?: readonly ResourceDimension[];
  readonly scopes?: readonly ResourceDebit[];
  readonly signal: AbortSignal;
  run(signal: AbortSignal): Promise<{
    readonly value: Value;
    readonly actual?: ResourceAmounts;
    readonly terminated: boolean;
  }>;
};
export type ProductTaskResources = {
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
  subdivide(limits: ResourceAmounts): ProductTaskResources | null;
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
        capacityScope(
          "task",
          id,
          "whole-task",
          dimension,
          [
            "memoryBytes",
            "bufferedBytes",
            "bufferedItems",
            "processes",
            "descendants",
            "concurrency",
          ].includes(dimension)
            ? "occupancy"
            : "cumulative",
        );
      let subdivisions = 0;
      const claimChild = () => {
        if (closed || subdivisions >= 64) return false;
        subdivisions++;
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
      const close = () => {
        closed = true;
        cancellation.abort();
        tasks.delete(id);
        replays.clear();
        ledger.closeTask(id);
      };
      const task: ProductTaskResources = {
        subdivide(narrower) {
          if (!resourceAmountsSchema.safeParse(narrower).success || !claimChild()) return null;
          return childTask(task, narrower, clock, ledger, 1, claimChild);
        },
        id,
        generation,
        expiresAt,
        close,
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
          if (closed || work.generation !== generation) return refuse("stale-generation");
          if (work.signal.aborted) return refuse("cancelled");
          if (overrun) return refuse("limit-exceeded");
          if ([...unknownUsage].some((dimension) => currentLimits[dimension] !== undefined))
            return refuse("quota-unknown");
          if (task.remaining("wallTimeMs") === 0) return refuse("admission-timeout");
          if (!resourceAmountsSchema.safeParse(work.amounts).success)
            return refuse("quota-unknown");
          const amounts = { ...work.amounts, operations: 1 };
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
          });
          const previous = replays.get(reservation);
          if (previous !== undefined) {
            if (previous.fingerprint !== fingerprint) return refuse("stale-generation");
            return previous.result;
          }
          if (replays.size >= 512) return refuse("limit-exceeded");
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
                      const outcome = await work.run(context.signal);
                      const actual =
                        outcome.actual === undefined
                          ? null
                          : debits.map((debit) => ({
                              ...debit,
                              amount:
                                debit.scope.ownerKind === "task" ||
                                debit.scope.ownerKind === "agent"
                                  ? (outcome.actual?.[debit.scope.dimension] ?? debit.amount)
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
          const result = run();
          replays.set(reservation, {
            fingerprint,
            result: result.then((settled) => ({ kind: "replayed", receipt: settled.receipt })),
          });
          return result;
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
  claimChild: () => boolean,
): ProductTaskResources {
  const id = randomUUID();
  let limits = { ...initial };
  let closed = false;
  let children = 0;
  const stop = new AbortController();
  const started = Number(clock.now());
  const scope = (dimension: ResourceDimension) => capacityScope("agent", id, "child", dimension);
  const child: ProductTaskResources = {
    id,
    refusal(state, dimension) {
      return parent.refusal(state, dimension);
    },
    generation: parent.generation,
    expiresAt: Math.min(parent.expiresAt, started + (limits.wallTimeMs ?? Number.MAX_SAFE_INTEGER)),
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
      return true;
    },
    execute(work) {
      const amounts = { ...work.amounts, operations: 1 };
      return parent.execute({
        ...work,
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
          ...Object.entries(amounts).map(([dimension, amount]) => ({
            scope: scope(dimension as ResourceDimension),
            amount,
            limit: limits[dimension as ResourceDimension] ?? Number.MAX_SAFE_INTEGER,
          })),
        ],
      });
    },
    subdivide(narrower) {
      if (
        closed ||
        depth >= 4 ||
        children >= 8 ||
        !resourceAmountsSchema.safeParse(narrower).success
      )
        return null;
      children++;
      return childTask(child, narrower, clock, ledger, depth + 1, claimChild);
    },
    close() {
      closed = true;
      stop.abort();
    },
  };
  return child;
}

/** Module lifetime is the process lifetime; callers may inject an isolated owner in tests. */
export const processProductResources = createProductResources(createSystemClock());
