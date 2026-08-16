/**
 * The adapter between the runtime and the rail.
 *
 * Mounted into a real renderer rather than called as a function, because what is
 * being checked is a subscription: that the first read resumes, that later reads
 * fold, and that a listener firing is what moves the projection. A test that
 * called the hook's helpers directly would prove the reducer works, which #358
 * already did.
 *
 * The feed is a fake, and deliberately: the port is three read-only questions,
 * so faking it costs four lines and the checks stay about folding rather than
 * about a scope tree. The real feed's own wiring is covered by `./shell.test.tsx`
 * with a live tree underneath it.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { ScopeEvent } from "../domain/index.ts";
import { createManualClock } from "../domain/index.ts";
import { scopeEvent } from "../presentation/activity/fixtures.ts";
import {
  ACTIVITY_PROJECTION_GENERATION,
  type ActivityCursor,
  describeActivity,
  EMPTY_ACTIVITY,
  initialActivityCursor,
  reduceActivity,
  type ShutdownState,
} from "../presentation/index.ts";
import { RenderGateProvider, useRenderGate } from "./components/render-gate.tsx";
import { mount, type Rendered } from "./harness.tsx";
import { STREAM_PUBLISH_CADENCE } from "./render-schedule.ts";
import {
  activityRenderKind,
  type RuntimeFeed,
  type RuntimeProjection,
  useRuntimeProjection,
} from "./runtime-feed.ts";

/**
 * One scope's lifecycle, as the tree would emit it.
 *
 * Built with the projection's own fixture helper rather than object literals:
 * `ScopeId` and `Instant` are branded, and a second builder here would be a
 * second opinion about what a scope event looks like.
 */
function opened(order: number, scope: string): ScopeEvent {
  return scopeEvent({ order, kind: "scope.opened", scope });
}

function completed(order: number, scope: string): ScopeEvent {
  return scopeEvent({ order, kind: "scope.terminal", scope, outcome: { kind: "completed" } });
}

function cancelling(order: number, scope: string): ScopeEvent {
  return scopeEvent({ order, kind: "scope.cancellation.requested", scope });
}

/** A feed a test drives by hand. */
function fakeFeed(initial: readonly ScopeEvent[] = []) {
  let events = [...initial];
  let shutdown: ShutdownState | null = null;
  const listeners = new Set<() => void>();

  const feed: RuntimeFeed = {
    events: () => events,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shutdown: () => shutdown,
  };

  return {
    feed,
    emit(...next: readonly ScopeEvent[]) {
      events = [...events, ...next];
      for (const listener of [...listeners]) {
        listener();
      }
    },
    setShutdown(state: ShutdownState | null) {
      shutdown = state;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscriberCount: () => listeners.size,
  };
}

/**
 * The hook's output, drawn.
 *
 * One line per entry plus the shutdown answer, which is enough to compare two
 * runs and cheap enough that the assertion is about the projection rather than
 * about a layout.
 */
function Probe(props: { readonly feed?: RuntimeFeed; readonly resumeFrom?: ActivityCursor }) {
  // One call site with the default spelled out, rather than a conditional pair.
  // Two calls behind a ternary are two hooks in a component that renders one of
  // them, which is the rule React cannot recover from when the branch changes.
  const gate = useRenderGate();
  const runtime = useRuntimeProjection(
    props.feed,
    props.resumeFrom ?? initialActivityCursor(),
    gate,
  );
  return (
    <box flexDirection="column">
      <text>{`shutdown:${runtime.shutdown === null ? "none" : runtime.shutdown.level}`}</text>
      <text>{`cursor:${runtime.activity.cursor.lastAppliedOrder ?? "none"}`}</text>
      {runtime.activity.entries.map((entry) => (
        <text key={entry.key}>{`${entry.key} ${describeActivity(entry)}`}</text>
      ))}
    </box>
  );
}

function probe(node: ReactNode): Promise<Rendered> {
  return mount(node, { shape: { columns: 80, rows: 20 } });
}

/** The probe's rows, which is what every check here reads. */
async function rowsOf(shell: Rendered): Promise<readonly string[]> {
  return (await shell.frame())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("the shell's view of its runtime", () => {
  test("shows work that opened, and reflects it settling", async () => {
    // The rail's whole purpose, through the subscription rather than the
    // reducer: an event arrives, the listener fires, and the frame changes.
    const source = fakeFeed();
    using view = await probe(<Probe feed={source.feed} />);

    source.emit(opened(1, "one"));
    expect((await rowsOf(view)).some((line) => line.includes("invocation running"))).toBe(true);

    source.emit(completed(2, "one"));
    const settled = await rowsOf(view);
    expect(settled.some((line) => line.includes("invocation completed"))).toBe(true);
    expect(settled.some((line) => line.includes("invocation running"))).toBe(false);
  });

  test("folds a suffix from a cursor to what folding everything would give", async () => {
    // The property a resubscription depends on, exercised through the shell's
    // own adapter. A view that came back at event three must be missing nothing
    // that a view present from the start would have.
    const whole = [opened(1, "one"), opened(2, "two"), completed(3, "one")];

    using fromStart = await probe(<Probe feed={fakeFeed(whole).feed} />);
    using resumed = await probe(
      <Probe
        feed={fakeFeed(whole).feed}
        resumeFrom={{ lastAppliedOrder: null, generation: ACTIVITY_PROJECTION_GENERATION }}
      />,
    );
    expect(await rowsOf(resumed)).toEqual(await rowsOf(fromStart));
  });

  test("rebuilds rather than resumes when the cursor is another build's", async () => {
    // A cursor from a different generation names a position in output this build
    // does not produce. Resuming from it would splice two reducers' work
    // together with no visible seam, so the whole sequence is folded instead —
    // and the entry that a resumed fold would have skipped is present.
    const whole = [opened(1, "one"), opened(2, "two")];
    using view = await probe(
      <Probe
        feed={fakeFeed(whole).feed}
        resumeFrom={{ lastAppliedOrder: 1, generation: ACTIVITY_PROJECTION_GENERATION + 1 }}
      />,
    );
    const lines = await rowsOf(view);
    expect(lines.some((line) => line.includes("scope:scope-one"))).toBe(true);
    expect(lines.some((line) => line.includes("scope:scope-two"))).toBe(true);
  });

  test("resumes past what a usable cursor already applied", async () => {
    // The other half of the same rule, and what makes the cursor worth carrying:
    // a resumable cursor skips what it has seen rather than replaying it.
    const whole = [opened(1, "one"), opened(2, "two")];
    using view = await probe(
      <Probe
        feed={fakeFeed(whole).feed}
        resumeFrom={{ lastAppliedOrder: 1, generation: ACTIVITY_PROJECTION_GENERATION }}
      />,
    );
    const lines = await rowsOf(view);
    expect(lines.some((line) => line.includes("scope:scope-two"))).toBe(true);
    expect(lines.some((line) => line.includes("scope:scope-one"))).toBe(false);
  });

  test("reports what the shutdown coordinator says, and its absence", async () => {
    const source = fakeFeed();
    using view = await probe(<Probe feed={source.feed} />);
    expect(await rowsOf(view)).toContain("shutdown:none");

    source.setShutdown({ shuttingDown: true, level: "escalated" });
    expect(await rowsOf(view)).toContain("shutdown:escalated");
  });

  test("projects nothing, and subscribes to nothing, without a feed", async () => {
    // A build with no runtime composed. The absence is the answer rather than a
    // value someone filled in.
    using view = await probe(<Probe />);
    const lines = await rowsOf(view);
    expect(lines).toContain("shutdown:none");
    expect(lines).toContain("cursor:none");
    expect(lines.length).toBe(2);
  });

  test("lets go of the feed when it goes away", async () => {
    // A subscription outliving its tree is a listener holding a projection for a
    // renderer that no longer exists.
    // The block is the point: leaving it is what tears the tree down, so this
    // also asserts that the harness's own teardown unmounts React rather than
    // only destroying the renderer underneath it.
    const source = fakeFeed();
    {
      using view = await probe(<Probe feed={source.feed} />);
      await rowsOf(view);
      expect(source.subscriberCount()).toBe(1);
    }

    // Immediately, with no wait: the harness unmounts synchronously, so "the
    // listener was released" is a fact about leaving the scope rather than
    // about a later tick that may or may not have run.
    expect(source.subscriberCount()).toBe(0);
  });
});

function runtimeOf(
  events: readonly ScopeEvent[],
  shutdown: ShutdownState | null = null,
): RuntimeProjection {
  return { activity: reduceActivity(EMPTY_ACTIVITY, events), shutdown };
}

describe("activityRenderKind", () => {
  test("treats opening more live work as a stream update", () => {
    expect(
      activityRenderKind(
        runtimeOf([opened(1, "one")]),
        runtimeOf([opened(1, "one"), opened(2, "two")]),
      ),
    ).toBe("stream");
  });

  test("treats a new terminal outcome as semantic", () => {
    expect(
      activityRenderKind(
        runtimeOf([opened(1, "one")]),
        runtimeOf([opened(1, "one"), completed(2, "one")]),
      ),
    ).toBe("semantic");
  });

  test("treats a newly cancelling lifecycle as semantic", () => {
    expect(
      activityRenderKind(
        runtimeOf([opened(1, "one")]),
        runtimeOf([opened(1, "one"), cancelling(2, "one")]),
      ),
    ).toBe("semantic");
  });

  test("treats a shutdown change as semantic", () => {
    expect(
      activityRenderKind(runtimeOf([]), runtimeOf([], { shuttingDown: true, level: "graceful" })),
    ).toBe("semantic");
  });
});

describe("a gated runtime projection", () => {
  test("holds a burst of openings until cadence, then shows every entry", async () => {
    const clock = createManualClock();
    const source = fakeFeed();
    using view = await probe(
      <RenderGateProvider clock={clock}>
        <Probe feed={source.feed} />
      </RenderGateProvider>,
    );

    source.emit(opened(1, "one"));
    expect((await rowsOf(view)).some((line) => line.includes("scope:scope-one"))).toBe(true);

    source.emit(opened(2, "two"), opened(3, "three"));
    const held = await rowsOf(view);
    expect(held.some((line) => line.includes("scope:scope-two"))).toBe(false);
    expect(held.some((line) => line.includes("scope:scope-three"))).toBe(false);

    await clock.advance(STREAM_PUBLISH_CADENCE);
    const flushed = await rowsOf(view);
    expect(flushed.some((line) => line.includes("scope:scope-two"))).toBe(true);
    expect(flushed.some((line) => line.includes("scope:scope-three"))).toBe(true);
  });

  test("flushes a held burst as soon as a terminal outcome arrives", async () => {
    const clock = createManualClock();
    const source = fakeFeed();
    using view = await probe(
      <RenderGateProvider clock={clock}>
        <Probe feed={source.feed} />
      </RenderGateProvider>,
    );
    await rowsOf(view);

    source.emit(opened(1, "one"));
    source.emit(opened(2, "two"));
    expect((await rowsOf(view)).some((line) => line.includes("scope:scope-two"))).toBe(false);

    source.emit(completed(3, "two"));
    const flushed = await rowsOf(view);
    expect(flushed.some((line) => line.includes("scope:scope-two"))).toBe(true);
    expect(flushed.some((line) => line.includes("invocation completed"))).toBe(true);
    expect(clock.pendingWaitCount()).toBe(0);
  });
});
