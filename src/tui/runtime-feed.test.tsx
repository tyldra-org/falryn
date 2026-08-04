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

import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import type { ScopeEvent } from "../domain/index.ts";
import { scopeEvent } from "../presentation/activity/fixtures.ts";
import {
  ACTIVITY_PROJECTION_GENERATION,
  type ActivityCursor,
  describeActivity,
  initialActivityCursor,
  type ShutdownState,
} from "../presentation/index.ts";
import { type RuntimeFeed, useRuntimeProjection } from "./runtime-feed.ts";

const live: TestRendererSetup[] = [];

afterEach(() => {
  while (live.length > 0) {
    live.pop()?.renderer.destroy();
  }
});

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
  const runtime = useRuntimeProjection(props.feed, props.resumeFrom ?? initialActivityCursor());
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

async function mount(node: Parameters<ReturnType<typeof createRoot>["render"]>[0]) {
  const setup = await createTestRenderer({ width: 80, height: 20, consoleMode: "disabled" });
  live.push(setup);
  createRoot(setup.renderer).render(node);
  return {
    setup,
    async frame(): Promise<readonly string[]> {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Bun.sleep(4);
        await setup.flush();
      }
      return setup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
  };
}

describe("the shell's view of its runtime", () => {
  test("shows work that opened, and reflects it settling", async () => {
    // The rail's whole purpose, through the subscription rather than the
    // reducer: an event arrives, the listener fires, and the frame changes.
    const source = fakeFeed();
    const view = await mount(<Probe feed={source.feed} />);

    source.emit(opened(1, "one"));
    expect((await view.frame()).some((line) => line.includes("invocation running"))).toBe(true);

    source.emit(completed(2, "one"));
    const settled = await view.frame();
    expect(settled.some((line) => line.includes("invocation completed"))).toBe(true);
    expect(settled.some((line) => line.includes("invocation running"))).toBe(false);
  });

  test("folds a suffix from a cursor to what folding everything would give", async () => {
    // The property a resubscription depends on, exercised through the shell's
    // own adapter. A view that came back at event three must be missing nothing
    // that a view present from the start would have.
    const whole = [opened(1, "one"), opened(2, "two"), completed(3, "one")];

    const fromStart = await mount(<Probe feed={fakeFeed(whole).feed} />);
    const resumed = await mount(
      <Probe
        feed={fakeFeed(whole).feed}
        resumeFrom={{ lastAppliedOrder: null, generation: ACTIVITY_PROJECTION_GENERATION }}
      />,
    );
    expect(await resumed.frame()).toEqual(await fromStart.frame());
  });

  test("rebuilds rather than resumes when the cursor is another build's", async () => {
    // A cursor from a different generation names a position in output this build
    // does not produce. Resuming from it would splice two reducers' work
    // together with no visible seam, so the whole sequence is folded instead —
    // and the entry that a resumed fold would have skipped is present.
    const whole = [opened(1, "one"), opened(2, "two")];
    const view = await mount(
      <Probe
        feed={fakeFeed(whole).feed}
        resumeFrom={{ lastAppliedOrder: 1, generation: ACTIVITY_PROJECTION_GENERATION + 1 }}
      />,
    );
    const lines = await view.frame();
    expect(lines.some((line) => line.includes("scope:scope-one"))).toBe(true);
    expect(lines.some((line) => line.includes("scope:scope-two"))).toBe(true);
  });

  test("resumes past what a usable cursor already applied", async () => {
    // The other half of the same rule, and what makes the cursor worth carrying:
    // a resumable cursor skips what it has seen rather than replaying it.
    const whole = [opened(1, "one"), opened(2, "two")];
    const view = await mount(
      <Probe
        feed={fakeFeed(whole).feed}
        resumeFrom={{ lastAppliedOrder: 1, generation: ACTIVITY_PROJECTION_GENERATION }}
      />,
    );
    const lines = await view.frame();
    expect(lines.some((line) => line.includes("scope:scope-two"))).toBe(true);
    expect(lines.some((line) => line.includes("scope:scope-one"))).toBe(false);
  });

  test("reports what the shutdown coordinator says, and its absence", async () => {
    const source = fakeFeed();
    const view = await mount(<Probe feed={source.feed} />);
    expect(await view.frame()).toContain("shutdown:none");

    source.setShutdown({ shuttingDown: true, level: "escalated" });
    expect(await view.frame()).toContain("shutdown:escalated");
  });

  test("projects nothing, and subscribes to nothing, without a feed", async () => {
    // A build with no runtime composed. The absence is the answer rather than a
    // value someone filled in.
    const view = await mount(<Probe />);
    const lines = await view.frame();
    expect(lines).toContain("shutdown:none");
    expect(lines).toContain("cursor:none");
    expect(lines.length).toBe(2);
  });

  test("lets go of the feed when it goes away", async () => {
    // A subscription outliving its tree is a listener holding a projection for a
    // renderer that no longer exists.
    const source = fakeFeed();
    const setup = await createTestRenderer({ width: 40, height: 10, consoleMode: "disabled" });
    live.push(setup);
    const root = createRoot(setup.renderer);
    root.render(<Probe feed={source.feed} />);
    await Bun.sleep(30);
    await setup.flush();
    expect(source.subscriberCount()).toBe(1);

    root.unmount();
    await Bun.sleep(30);
    expect(source.subscriberCount()).toBe(0);
  });
});
