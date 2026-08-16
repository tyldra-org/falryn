/**
 * What the shell knows about the runtime it is running inside.
 *
 * The adapter between the runtime the invocation already composed and the
 * projection #358 built to read it. Both halves existed and never met: the scope
 * tree emits ordered events and the reducer folds them, and nothing called the
 * reducer — so the rail projected an empty value and the status line reported
 * that no runtime was attached while the shell was holding a shutdown
 * coordinator and running inside a live scope.
 *
 * ## A feed, not a runtime handle
 *
 * The port is deliberately three read-only questions rather than the scope tree
 * itself. A view holding a `ScopeTree` could cancel a scope, and a status line
 * that can stop work is a status line that will eventually stop the wrong thing.
 * It is also what keeps the tests here honest: a feed is four lines to fake, so
 * the checks exercise the folding rather than a runtime.
 *
 * ## Resuming rather than rebuilding
 *
 * Every read skips events at or before the cursor it already holds, so handing
 * the whole log to the reducer applies only what is new and produces what
 * folding the suffix would — the property #358 asserts, and the reason a cursor
 * exists at all.
 *
 * Subscribing and staying subscribed are different operations. The first read
 * is a resubscription: `resubscribeActivity` is handed a cursor and answers both
 * halves of the question — whether it can be resumed from, and what to do when
 * it cannot — so a caller cannot check the generation and forget to act on it.
 * Reads after it fold onto the projection already held, because
 * `resubscribeActivity` starts from an empty entry set by design and calling it
 * twice would discard everything applied in between.
 *
 * Nothing here draws, and nothing here can restart anything.
 */

import { useEffect, useRef, useState } from "react";
import type { ScopeTree, ShutdownCoordinator } from "../application/index.ts";
import type { ScopeEvent } from "../domain/index.ts";
import type {
  ActivityCursor,
  ActivityEntry,
  ActivityProjection,
  ShutdownState,
} from "../presentation/index.ts";
import {
  EMPTY_ACTIVITY,
  initialActivityCursor,
  reduceActivity,
  resubscribeActivity,
} from "../presentation/index.ts";
import { IMMEDIATE_GATE, type RenderGate } from "./components/render-gate.tsx";
import type { RenderKind } from "./render-schedule.ts";

export type RuntimeFeed = {
  /** Every scope event so far, in order. The reducer skips what it has applied. */
  events(): readonly ScopeEvent[];
  /**
   * Calls back when there is something new to fold.
   *
   * The listener takes no argument on purpose: an event handed straight to a
   * reducer would tempt a caller into applying it without its cursor, and
   * skipping the read is exactly how a view drifts from the log it claims to
   * project.
   */
  subscribe(listener: () => void): () => void;
  /** What the shutdown coordinator says now, or `null` when there is none. */
  shutdown(): ShutdownState | null;
};

export type RuntimeSources = {
  readonly scopes: ScopeTree | undefined;
  readonly shutdown: ShutdownCoordinator | undefined;
};

/**
 * The feed for a real invocation, or `undefined` when there is nothing to read.
 *
 * Both sources are optional and either one alone is enough, because they are
 * separately absent: a caller can compose a scope tree with no shutdown
 * lifecycle, and the shell is handed a coordinator on paths where it never gets
 * a tree. Requiring both would have made a coordinator invisible to the status
 * line whenever the tree was missing, which is the same "attached and reported
 * as absent" defect this issue exists to fix.
 *
 * `undefined` for neither, so "no runtime" stays a distinct answer from "a
 * runtime that has nothing to say".
 *
 * `isShuttingDown()` and `level()` are read on each fold rather than subscribed
 * to, because the coordinator publishes no event and the first phase it runs
 * cancels the root scope — which the feed is already listening to.
 */
export function runtimeFeed(sources: RuntimeSources): RuntimeFeed | undefined {
  const { scopes, shutdown } = sources;
  if (scopes === undefined && shutdown === undefined) {
    return undefined;
  }
  return {
    events: () => scopes?.events() ?? [],
    subscribe: (listener) => scopes?.subscribe(() => listener()) ?? (() => {}),
    shutdown: () =>
      shutdown === undefined
        ? null
        : { shuttingDown: shutdown.isShuttingDown(), level: shutdown.level() },
  };
}

export type RuntimeProjection = {
  readonly activity: ActivityProjection;
  /** `null` when no coordinator is attached. Absent is not the same as calm. */
  readonly shutdown: ShutdownState | null;
};

/** What a shell with no feed projects: nothing, and honestly nothing. */
export const NO_RUNTIME_PROJECTION: RuntimeProjection = {
  activity: EMPTY_ACTIVITY,
  shutdown: null,
};

/**
 * A projection of the feed, kept current.
 *
 * Subscribing is one operation and staying subscribed is another, and they call
 * different functions on purpose.
 *
 * The first read is a *resubscription*: it is handed a cursor and answers
 * whether that cursor can be resumed from or has to be rebuilt past. Every read
 * after it is an ordinary fold onto the projection already held —
 * `resubscribeActivity` starts from an empty entry set by design, so calling it
 * a second time would discard everything applied since the first.
 *
 * Both skip events at or before the cursor, so a listener firing ten times while
 * nothing new arrived costs ten comparisons rather than ten rebuilds, and the
 * reducer returns the same projection object when nothing applied — which stops
 * the frame re-rendering as well.
 *
 * Publishing is a separate question from folding. The fold always runs; a
 * render gate may hold a stream snapshot until cadence or until input/semantic
 * facts flush it. The default gate publishes immediately, so existing frame
 * tests do not wait on cadence.
 */
export function useRuntimeProjection(
  feed?: RuntimeFeed,
  /**
   * Where a returning view left off.
   *
   * Defaulted rather than required, because this build has nowhere to persist a
   * cursor across a run — nothing outlives the process yet. The parameter is the
   * seam that keeps the resume path real: a caller that has a cursor resumes
   * from it, and one recorded under another generation is rebuilt past rather
   * than spliced into output this build would not produce.
   */
  resumeFrom: ActivityCursor = initialActivityCursor(),
  gate: RenderGate = IMMEDIATE_GATE,
): RuntimeProjection {
  const held = useRef<RuntimeProjection>(resumed(feed, resumeFrom));
  const [projection, setProjection] = useState<RuntimeProjection>(() => held.current);

  useEffect(() => {
    const unsubscribeDue = gate.onDue(() => {
      setProjection(held.current);
    });

    const publish = (next: RuntimeProjection, kind: RenderKind): void => {
      held.current = next;
      if (gate.note(kind)) {
        setProjection(held.current);
      }
    };

    if (feed === undefined) {
      publish(NO_RUNTIME_PROJECTION, "semantic");
      return unsubscribeDue;
    }
    // Read before subscribing, not after: an event that arrived between the
    // first read and this effect is already in `events()`, and reading second is
    // how a subscriber misses exactly the events it was created to catch.
    const first = folded(feed, held.current);
    if (first !== held.current) {
      publish(first, activityRenderKind(held.current, first));
    } else if (held.current.activity.entries.length > 0 || held.current.shutdown !== null) {
      // The first paint already came from `useState`'s initializer, which reads
      // the feed before this effect can subscribe. Mark that snapshot published
      // so a later stream burst holds instead of looking like the first paint.
      gate.note("stream");
    }
    const unsubscribeFeed = feed.subscribe(() => {
      const previous = held.current;
      const next = folded(feed, previous);
      if (next === previous) {
        return;
      }
      publish(next, activityRenderKind(previous, next));
    });
    return () => {
      unsubscribeFeed();
      unsubscribeDue();
    };
  }, [feed, gate]);

  return projection;
}

/**
 * Stream vs semantic for an activity fold.
 *
 * A new or changed terminal outcome, a newly cancelling lifecycle, or a
 * shutdown change must paint now — those are facts the user is acting on, not
 * display-only motion. Opening or revising live work is the burst that may wait.
 */
export function activityRenderKind(
  previous: RuntimeProjection,
  next: RuntimeProjection,
): RenderKind {
  if (!sameShutdown(previous.shutdown, next.shutdown)) {
    return "semantic";
  }
  if (gainedTerminalOrCancel(previous.activity, next.activity)) {
    return "semantic";
  }
  return "stream";
}

function gainedTerminalOrCancel(previous: ActivityProjection, next: ActivityProjection): boolean {
  const before = new Map(previous.entries.map((entry) => [entry.key, entry]));
  for (const entry of next.entries) {
    const prior = before.get(entry.key);
    if (becameCancelling(prior, entry) || outcomeChanged(prior, entry)) {
      return true;
    }
  }
  return false;
}

function becameCancelling(prior: ActivityEntry | undefined, entry: ActivityEntry): boolean {
  return entry.lifecycle === "cancelling" && prior?.lifecycle !== "cancelling";
}

function outcomeChanged(prior: ActivityEntry | undefined, entry: ActivityEntry): boolean {
  if (entry.outcome === null) {
    return false;
  }
  return prior?.outcome?.kind !== entry.outcome.kind;
}

/** The first read of a subscription: resume from the cursor, or rebuild past it. */
function resumed(feed: RuntimeFeed | undefined, cursor: ActivityCursor): RuntimeProjection {
  if (feed === undefined) {
    return NO_RUNTIME_PROJECTION;
  }
  return {
    activity: resubscribeActivity(cursor, feed.events()).projection,
    shutdown: feed.shutdown(),
  };
}

/** Every read after the first: what is new, applied to what is already held. */
function folded(feed: RuntimeFeed, previous: RuntimeProjection): RuntimeProjection {
  const activity = reduceActivity(previous.activity, feed.events());
  const shutdown = feed.shutdown();
  if (activity === previous.activity && sameShutdown(shutdown, previous.shutdown)) {
    // Identity, so an event that applied nothing does not re-render the frame.
    return previous;
  }
  return { activity, shutdown };
}

function sameShutdown(left: ShutdownState | null, right: ShutdownState | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.shuttingDown === right.shuttingDown && left.level === right.level;
}
