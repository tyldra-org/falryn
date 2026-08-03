/**
 * The scope one invocation runs under.
 *
 * Every assertion here resolves through a manual clock, so what is measured is
 * the derivation and the expiry rule rather than whether a machine happened to
 * schedule a timer in time. The observable behavior on a real process — an
 * interrupt, a deadline, and the code each produces — is
 * `src/cli/process-boundary.test.ts`, because none of that is visible in-process.
 */

import { describe, expect, test } from "bun:test";
import type { ScopeHandle } from "../application/index.ts";
import { createScopeTree } from "../application/index.ts";
import {
  createManualClock,
  deadlineAt,
  instant,
  type ManualClock,
  scopeId,
} from "../domain/index.ts";
import {
  createInvocationGovernance,
  type InvocationGovernance,
  openInvocationScope,
  runUnderScope,
} from "./invocation-scope.ts";

function governed(clock: ManualClock, rootDeadline: number | null = null): InvocationGovernance {
  return {
    clock,
    scopes: createScopeTree({
      clock,
      ...(rootDeadline === null ? {} : { rootDeadline: deadlineAt(instant(rootDeadline)) }),
    }),
  };
}

/**
 * The invocation's scope, or a failed test.
 *
 * A tree that refuses to derive is a real branch — the caller runs ungoverned —
 * and it is not the branch any of these assertions is about.
 */
function openScope(governance: InvocationGovernance, timeoutMs: number | null): ScopeHandle {
  const scope = openInvocationScope(governance, timeoutMs);
  if (scope === null) {
    throw new Error("the invocation scope could not be derived");
  }
  return scope;
}

/** A promise that settles only when the test decides it does. */
function pending<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve: (value: Value) => void = () => {};
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("opening the scope", () => {
  test("turns --timeout into a deadline on the invocation", () => {
    const clock = createManualClock(instant(1_000));
    const scope = openInvocationScope(governed(clock), 5_000);

    expect(scope?.kind).toBe("invocation");
    expect(scope?.deadline).toEqual(deadlineAt(instant(6_000)));
  });

  test("leaves an invocation with no --timeout undeadlined", () => {
    const scope = openInvocationScope(governed(createManualClock(instant(1_000))), null);
    expect(scope?.deadline).toBeNull();
  });

  test("never enlarges a deadline it inherited", () => {
    // The rule the domain owns, exercised through the composition: a caller
    // asking for more time than its parent has is capped, not obeyed.
    const clock = createManualClock(instant(1_000));
    const scope = openInvocationScope(governed(clock, 2_000), 60_000);

    expect(scope?.deadline).toEqual(deadlineAt(instant(2_000)));
  });

  test("names the scope when the caller named it", () => {
    const clock = createManualClock(instant(0));
    const governance: InvocationGovernance = {
      ...governed(clock),
      scopeId: scopeId.from("named-invocation"),
    };
    expect(openInvocationScope(governance, null)?.scopeId).toBe(scopeId.from("named-invocation"));
  });
});

describe("running under the scope", () => {
  test("reports what the work said when the work finishes first", async () => {
    const clock = createManualClock(instant(0));
    const governance = governed(clock);
    const scope = openScope(governance, 5_000);

    const run = await runUnderScope(governance, scope, async () => "answer");

    expect(run).toEqual({ kind: "finished", value: "answer" });
    // The scope is settled rather than left live behind a finished invocation.
    expect(governance.scopes.state(scope.scopeId)).toMatchObject({
      status: "terminal",
      outcome: { kind: "completed" },
    });
  });

  test("reports timed-out when the deadline passes first", async () => {
    const clock = createManualClock(instant(0));
    const governance = governed(clock);
    const scope = openScope(governance, 5_000);
    const work = pending<string>();

    const running = runUnderScope(governance, scope, () => work.promise);
    await clock.advanceTo(instant(5_000));

    // `timed-out` rather than `cancelled`: the tree recorded a
    // `deadline-exceeded` reason, and the acknowledgement reads it.
    expect(await running).toEqual({
      kind: "stopped",
      outcome: { kind: "timed-out", effect: "none" },
    });
    // Nothing waited for the work, and nothing killed it either.
    work.resolve("late");
  });

  test("reports cancelled when the scope is cancelled first", async () => {
    const clock = createManualClock(instant(0));
    const governance = governed(clock);
    const scope = openScope(governance, 60_000);
    const work = pending<string>();

    const running = runUnderScope(governance, scope, () => work.promise);
    // What an interrupt does: the policy cancels the root, and cancellation
    // travels downward to the invocation derived under it.
    governance.scopes.cancel(governance.scopes.root().scopeId, { kind: "requested" });

    expect(await running).toEqual({
      kind: "stopped",
      outcome: { kind: "cancelled", effect: "none" },
    });
    work.resolve("late");
  });

  test("cancels an invocation with nothing to wait on but a signal", async () => {
    const clock = createManualClock(instant(0));
    const governance = governed(clock);
    const scope = openScope(governance, null);
    const work = pending<string>();

    const running = runUnderScope(governance, scope, () => work.promise);
    governance.scopes.cancel(governance.scopes.root().scopeId, { kind: "requested" });

    expect((await running).kind).toBe("stopped");
    work.resolve("late");
  });

  test("reports uncertain when the run had already changed something", async () => {
    const clock = createManualClock(instant(0));
    const governance = governed(clock);
    const scope = openScope(governance, 60_000);
    const work = pending<string>();

    const running = runUnderScope(governance, scope, () => work.promise);
    governance.scopes.recordEffect(scope.scopeId, "partial");
    governance.scopes.cancel(governance.scopes.root().scopeId, { kind: "requested" });

    // Effect certainty outranks the cancellation. A caller reading `cancelled`
    // and retrying would repeat a change that already happened.
    expect(await running).toEqual({
      kind: "stopped",
      outcome: { kind: "uncertain", effect: "uncertain" },
    });
    work.resolve("late");
  });

  test("does not stop a run whose deadline has not arrived", async () => {
    const clock = createManualClock(instant(0));
    const governance = governed(clock);
    const scope = openScope(governance, 5_000);

    await clock.advanceTo(instant(4_999));
    const run = await runUnderScope(governance, scope, async () => "answer");

    expect(run).toEqual({ kind: "finished", value: "answer" });
  });

  test("stops immediately when the deadline had already passed", async () => {
    const clock = createManualClock(instant(0));
    const governance = governed(clock);
    const scope = openScope(governance, 1);
    await clock.advanceTo(instant(10));
    const work = pending<string>();

    // A deadline that expired before the work began still ends the invocation:
    // the wait resolves at once rather than granting time nobody had.
    const running = runUnderScope(governance, scope, () => work.promise);
    await clock.advanceTo(instant(11));
    expect(await running).toEqual({
      kind: "stopped",
      outcome: { kind: "timed-out", effect: "none" },
    });
    work.resolve("late");
  });
});

describe("a governance nobody supplied", () => {
  test("still applies a deadline, so no caller silently drops --timeout", () => {
    const governance = createInvocationGovernance();
    const scope = openInvocationScope(governance, 5_000);

    expect(scope?.deadline).not.toBeNull();
    // Nothing holds a signal for it, which is the one thing it cannot do: an
    // interrupt reaches a run only through the tree the entry composed.
    expect(scope?.signal.aborted).toBe(false);
  });
});
