/**
 * Composition of the control-flow lifecycle.
 *
 * This is the one place that knows an interrupt should cancel the root scope
 * and start a shutdown. Keeping that wiring here means the policy, the scope
 * tree, and the coordinator each stay testable on their own, and the host
 * signal adapter stays a leaf that knows none of them.
 */

import {
  type ClockPort,
  type ConfigurationGeneration,
  type Deadline,
  FIRST_CONFIGURATION_GENERATION,
  type InterruptSignal,
  type ScopeId,
  type ShutdownLevel,
  type ShutdownReport,
  type SignalPort,
  type Unsubscribe,
} from "../domain/index.ts";
import {
  attachInterruptionPolicy,
  createInterruptionPolicy,
  type InterruptionDecision,
  type InterruptionPolicy,
} from "./interruption.ts";
import { contextFromScope, type RuntimeContext } from "./runtime-context.ts";
import { createScopeTree, type ScopeTree } from "./scope-tree.ts";
import { createShutdownCoordinator, type ShutdownCoordinator } from "./shutdown-coordinator.ts";

export type RuntimeLifecycleOptions = {
  readonly clock: ClockPort;
  readonly signals: SignalPort;
  readonly configurationGeneration?: ConfigurationGeneration;
  readonly rootScopeId?: ScopeId;
  readonly rootDeadline?: Deadline | null;
};

export type RuntimeLifecycle = {
  readonly scopes: ScopeTree;
  readonly shutdown: ShutdownCoordinator;
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

  const scopes = createScopeTree({
    clock,
    ...(options.rootScopeId === undefined ? {} : { rootScopeId: options.rootScopeId }),
    ...(options.rootDeadline === undefined ? {} : { rootDeadline: options.rootDeadline }),
  });
  const shutdown = createShutdownCoordinator({ clock, scopeTree: scopes });
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
      switch (decision.action) {
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
      }
    },
  );

  return {
    scopes,
    shutdown,
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
