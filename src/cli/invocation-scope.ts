/**
 * The scope one invocation runs under, and what stops it.
 *
 * Two facts about a run reach the command from outside it: whether someone
 * asked it to stop, and how long it was given. Both already have owners —
 * `src/domain/` declares deadlines and their inheritance rule, and
 * `src/application/` owns the scope tree, the escalation policy, and the
 * mapping from a stopped scope to a terminal outcome. This module composes
 * them for the CLI and writes none of them again.
 *
 * What it adds is the one thing neither owner can supply: *when to look*.
 * Deadline expiry is polled rather than timer-driven, deliberately, so the tree
 * stays a pure function of the clock — which leaves the surface that owns
 * waiting to decide when to poll. For an invocation, that is here.
 *
 * The work is never cancelled *by* this module. A command is asked to stop
 * through the scope's signal and settles when it settles; what this module
 * decides is that the invocation is no longer waiting for it, which is the
 * difference between a cancellation and a kill.
 */

import {
  createRuntimeLifecycle,
  createScopeTree,
  type ScopeHandle,
  type ScopeTree,
  type ShutdownCoordinator,
} from "../application/index.ts";
import {
  type ClockPort,
  createSystemClock,
  type Deadline,
  deadlineIn,
  duration,
  type ScopeId,
  type TerminalOutcome,
} from "../domain/index.ts";
import { createProcessSignalPort } from "../integrations/index.ts";

/**
 * What governs one invocation.
 *
 * A clock and a scope tree, and — when the caller composed a runtime — the
 * shutdown coordinator that runtime owns. The tree may be the composed
 * runtime's, which the entry supplies so an interrupt on the root reaches the
 * invocation, or a private one, which is what a caller that never needs to
 * interrupt anything gets.
 */
export type InvocationGovernance = {
  readonly clock: ClockPort;
  readonly scopes: ScopeTree;
  /**
   * Where a long-lived surface registers what has to be released on the way out.
   *
   * Absent for a private governance, which composed no runtime and so has no
   * coordinator to offer. Present since #23, because the interactive shell holds
   * the user's terminal: an escalated interrupt returns from no command and
   * flushes no stream, and `restore-terminal` is the only path that gives the
   * terminal back on it.
   */
  readonly shutdown?: ShutdownCoordinator;
  /**
   * The scope the invocation is derived under. The tree's root when absent.
   */
  readonly parentScopeId?: ScopeId;
  /**
   * The identity to give the invocation's own scope.
   *
   * Supplied by a caller that has already named the work, so it can record an
   * effect against the scope the invocation is running under. Without it the
   * tree names the scope itself.
   */
  readonly scopeId?: ScopeId;
};

/**
 * A governance with no interrupt behind it.
 *
 * Built when a caller supplied none, so `--timeout` is honoured on every path
 * rather than only on the one the entry composes. An accepted option that some
 * callers silently drop is the defect this delivery exists to remove.
 */
export function createInvocationGovernance(): InvocationGovernance {
  const clock = createSystemClock();
  return { clock, scopes: createScopeTree({ clock }) };
}

/** A governance an interrupt can reach, and the subscription it holds. */
export type HostGovernance = {
  readonly governance: InvocationGovernance;
  /**
   * Releases the host signal subscription.
   *
   * Must be called even on a clean exit: an unreleased subscription keeps the
   * process alive after there is nothing left to interrupt.
   */
  dispose(): void;
};

/**
 * The governance the process entry runs under.
 *
 * The composed control-flow lifecycle: the system clock, the real signal
 * adapter, the escalation policy, and the root scope an interrupt cancels. One
 * function rather than a sequence spelled at each entry, so the harness that
 * proves an interrupt reaches a command is exercising the same composition the
 * shipped binary uses rather than a copy of it that could drift.
 *
 * It opens nothing else: no database, no workspace scan, no provider.
 */
export function createHostGovernance(scopeId?: ScopeId): HostGovernance {
  const clock = createSystemClock();
  const lifecycle = createRuntimeLifecycle({ clock, signals: createProcessSignalPort() });
  return {
    governance: {
      clock,
      scopes: lifecycle.scopes,
      // The composed runtime's own coordinator, so a surface that registers with
      // it is registering with the sequence an interrupt actually starts —
      // rather than with a second one nothing would ever run.
      shutdown: lifecycle.shutdown,
      ...(scopeId === undefined ? {} : { scopeId }),
    },
    dispose: () => lifecycle.dispose(),
  };
}

/**
 * Opens the scope this invocation runs under.
 *
 * `--timeout` becomes that scope's requested deadline. It is a request rather
 * than a setting: `derive` caps it by whatever the parent already carried, so a
 * caller can never enlarge a limit it inherited. Returns `null` when the tree
 * refused to derive — a budget or depth limit — and the invocation then runs
 * ungoverned rather than failing over a diagnostic facility.
 */
export function openInvocationScope(
  governance: InvocationGovernance,
  timeoutMs: number | null,
): ScopeHandle | null {
  const parentId = governance.parentScopeId ?? governance.scopes.root().scopeId;
  const requested: Deadline | null =
    timeoutMs === null ? null : deadlineIn(governance.clock, duration(timeoutMs));

  const derived = governance.scopes.derive(parentId, {
    kind: "invocation",
    deadline: requested,
    ...(governance.scopeId === undefined ? {} : { scopeId: governance.scopeId }),
  });
  return derived.ok ? derived.value : null;
}

/** What running work under a scope produced: its value, or why it stopped. */
export type GovernedRun<Value> =
  | { readonly kind: "finished"; readonly value: Value }
  /** The scope stopped first. The work may still be running; nothing waits for it. */
  | { readonly kind: "stopped"; readonly outcome: TerminalOutcome };

/**
 * Runs work under a scope, and stops waiting when the scope does.
 *
 * The race is the contract. When the work wins, the scope settles as completed
 * and the caller reports what the work said. When the scope wins — an interrupt
 * cancelled it, or its deadline passed — the caller reports the scope's own
 * terminal outcome, which carries the effect the scope recorded. That is what
 * makes an interrupted run that had already changed something exit as uncertain
 * rather than as a clean cancellation.
 *
 * Nothing here kills the work. A pending command holds no lock and writes
 * nothing after this returns, and abandoning it is precisely how a cancelled
 * run reaches its terminal record instead of waiting for work that was asked to
 * stop.
 */
export async function runUnderScope<Value>(
  governance: InvocationGovernance,
  scope: ScopeHandle,
  work: (signal: AbortSignal) => Promise<Value>,
): Promise<GovernedRun<Value>> {
  // Ends the wait once the race is decided. Without it a run given
  // `--timeout 86400000` would hold a day-long timer after its work finished,
  // and the process would sit there with nothing left to do — the exit is taken
  // by letting the loop drain, so anything still armed is a process that hangs.
  const decided = new AbortController();

  const finished = work(scope.signal).then((value) => ({ kind: "finished", value }) as const);
  const stopped = untilScopeStops(governance, scope, decided.signal).then(
    () => ({ kind: "stopped" }) as const,
  );

  const first = await Promise.race([finished, stopped]).finally(() => decided.abort());
  if (first.kind === "finished") {
    // Settled as completed so the scope is not left live behind a finished
    // invocation. The outcome the caller reports is the command's own.
    governance.scopes.complete(scope.scopeId);
    return first;
  }

  // `acknowledge` is the terminal acknowledgement a cancelling scope waits for,
  // and it decides between `cancelled` and `timed-out` from the reason the tree
  // recorded — not from anything re-derived here.
  const settled = governance.scopes.acknowledge(scope.scopeId);
  return {
    kind: "stopped",
    // A scope that could not be acknowledged was already terminal or already
    // evicted. Neither is a run that completed, and claiming so is the one
    // answer this must never give.
    outcome: settled.ok ? settled.value : { kind: "uncertain", effect: "uncertain" },
  };
}

/**
 * Resolves when the invocation should stop waiting.
 *
 * Cancellation is the scope's own signal. Expiry is a wait on the clock
 * followed by `expireDeadlines`, which is what turns a passed instant into a
 * cancelling scope with a `deadline-exceeded` reason — the reason
 * `acknowledge` later reads to answer `timed-out` rather than `cancelled`.
 *
 * Exported since #23 for the one caller that cannot use {@link runUnderScope}.
 * That helper *races* work against the scope, which is exactly right for a
 * command that runs to completion on its own. The interactive shell has no such
 * completion in this build: the scope stopping is the only thing that ends it,
 * so racing the two would be racing a promise against the very signal that
 * resolves it. It observes the stop directly instead, tears itself down, and
 * lets the caller read the outcome off the same scope.
 *
 * The `settled` signal must be aborted once the caller is done, or a run given a
 * long `--timeout` keeps a timer armed after there is nothing left to govern.
 */
export async function untilScopeStops(
  governance: InvocationGovernance,
  scope: ScopeHandle,
  /** Aborts once the race is decided, so a wait outlives nothing. */
  settled: AbortSignal,
): Promise<void> {
  if (scope.signal.aborted) {
    return;
  }

  const until = AbortSignal.any([scope.signal, settled]);
  if (scope.deadline === null) {
    await aborted(until);
    return;
  }

  const reached = await governance.clock.waitUntil(scope.deadline.expiresAt, until);
  // Only a wait that actually reached the instant expires anything. One the
  // finished work ended must not cancel the scope it was racing.
  if (reached === "reached" && !settled.aborted) {
    governance.scopes.expireDeadlines();
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
