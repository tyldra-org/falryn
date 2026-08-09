/**
 * Composition of the control-flow lifecycle.
 *
 * This is the one place that knows an interrupt should cancel the root scope
 * and start a shutdown. Keeping that wiring here means the policy, the scope
 * tree, and the coordinator each stay testable on their own, and the host
 * signal adapter stays a leaf that knows none of them.
 */

import {
  addDuration,
  assertNever,
  type ClockPort,
  type ConfigurationGeneration,
  type Deadline,
  duration,
  FIRST_CONFIGURATION_GENERATION,
  type InterruptSignal,
  type SchedulerLimits,
  type SchedulerPort,
  type ScopeId,
  type ShutdownLevel,
  type ShutdownReport,
  type SignalPort,
  type Unsubscribe,
} from "../domain/index.ts";
import { createDiagnosticsCollector, type DiagnosticsCollector } from "./diagnostics-collector.ts";
import {
  attachInterruptionPolicy,
  createInterruptionPolicy,
  type InterruptionDecision,
  type InterruptionPolicy,
} from "./interruption.ts";
import { contextFromScope, type RuntimeContext } from "./runtime-context.ts";
import { createScheduler } from "./scheduler.ts";
import { createScopeTree, type ScopeTree } from "./scope-tree.ts";
import { createShutdownCoordinator, type ShutdownCoordinator } from "./shutdown-coordinator.ts";

export type RuntimeLifecycleOptions = {
  readonly clock: ClockPort;
  readonly signals: SignalPort;
  readonly configurationGeneration?: ConfigurationGeneration;
  readonly rootScopeId?: ScopeId;
  readonly rootDeadline?: Deadline | null;
  /** Shared by every subsystem. One is created when none is supplied. */
  readonly diagnostics?: DiagnosticsCollector;
  readonly schedulerLimits?: Partial<SchedulerLimits>;
};

/**
 * How often the drain participant re-checks for in-flight work.
 *
 * Polled rather than event-driven because the scheduler reports its running
 * count and does not publish a quiescence signal; the poll resolves through
 * `ClockPort`, so it costs nothing under a manual clock.
 */
const DRAIN_POLL_MS = 10;

export type RuntimeLifecycle = {
  readonly scopes: ScopeTree;
  readonly shutdown: ShutdownCoordinator;
  readonly scheduler: SchedulerPort<unknown>;
  readonly diagnostics: DiagnosticsCollector;
  readonly interruption: InterruptionPolicy;
  readonly rootContext: RuntimeContext;

  /** Begins shutdown, or returns the sequence already running. */
  requestShutdown(level?: ShutdownLevel): Promise<ShutdownReport>;

  /** Observations of what each interrupt decided, in arrival order. */
  interruptions(): readonly { decision: InterruptionDecision; signal: InterruptSignal }[];

  /**
   * Releases the host subscription.
   *
   * Must be called even on a clean exit: an unreleased signal subscription
   * keeps the process alive after there is nothing left to interrupt.
   */
  dispose(): void;
};

export function createRuntimeLifecycle(options: RuntimeLifecycleOptions): RuntimeLifecycle {
  const { clock, signals } = options;
  const generation = options.configurationGeneration ?? FIRST_CONFIGURATION_GENERATION;

  const diagnostics = options.diagnostics ?? createDiagnosticsCollector({ clock });
  const scopes = createScopeTree({
    clock,
    diagnostics,
    ...(options.rootScopeId === undefined ? {} : { rootScopeId: options.rootScopeId }),
    ...(options.rootDeadline === undefined ? {} : { rootDeadline: options.rootDeadline }),
  });
  const shutdown = createShutdownCoordinator({ clock, scopeTree: scopes, diagnostics });
  const scheduler = createScheduler<unknown>({
    clock,
    scopeTree: scopes,
    diagnostics,
    ...(options.schedulerLimits === undefined ? {} : { limits: options.schedulerLimits }),
  });

  // Registered in `stop-scheduling`, the phase the canonical shutdown order
  // assigns to it — third, immediately after the root scope is cancelled.
  // `drain-events` is the semantic event log, not scheduled work.
  //
  // The participant does both halves within its own phase deadline: the root
  // cancellation in the previous phase has already told in-flight units to
  // stop, so this waits for them to actually reach a terminal state. A unit
  // that will not stop leaves this participant unfinished, which is what turns
  // it into an `uncertain` shutdown rather than a clean exit.
  shutdown.register({
    name: "scheduler-drain",
    phase: "stop-scheduling",
    async run(context) {
      while (scheduler.report().running > 0) {
        if (context.signal.aborted) {
          // The phase ended first. Returning would claim a drain that did not
          // happen, so this participant stays unfinished by never resolving
          // before its phase closed.
          throw new Error("scheduler did not drain before the phase deadline");
        }
        await context.clock.waitUntil(
          addDuration(context.clock.now(), duration(DRAIN_POLL_MS)),
          context.signal,
        );
      }
    },
  });
  const interruption = createInterruptionPolicy(clock);
  const observed: { decision: InterruptionDecision; signal: InterruptSignal }[] = [];

  let sequence: Promise<ShutdownReport> | null = null;

  const start = (level: ShutdownLevel): Promise<ShutdownReport> => {
    sequence ??= shutdown.shutdown({ level });
    return sequence;
  };

  let unsubscribe: Unsubscribe = attachInterruptionPolicy(
    signals,
    interruption,
    (decision, signal) => {
      observed.push({ decision, signal });
      const action = decision.action;
      switch (action) {
        case "request-cancellation":
          scopes.cancel(scopes.root().scopeId, { kind: "requested" });
          void start("graceful");
          break;
        case "escalate":
          shutdown.escalate("escalated");
          void start("escalated");
          break;
        case "force":
          shutdown.escalate("forced");
          void start("forced");
          break;
        case "ignored":
          break;
        default:
          assertNever(action, "unhandled interruption decision");
      }
    },
  );

  return {
    scopes,
    shutdown,
    scheduler,
    diagnostics,
    interruption,
    rootContext: contextFromScope(scopes.root(), generation),

    requestShutdown(level: ShutdownLevel = "graceful"): Promise<ShutdownReport> {
      return start(level);
    },

    interruptions() {
      return [...observed];
    },

    dispose(): void {
      unsubscribe();
      unsubscribe = () => {};
    },
  };
}
