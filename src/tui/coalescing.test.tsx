/**
 * Coalescing changes how often the shell repaints. It must not change what the
 * shell says happened.
 *
 * The reducer's half of this is already owned: `../presentation/transcript/
 * coalesce.test.ts` asserts the fold is frame-invariant — the same result
 * whatever the frames — and that a terminal status survives once observed. What
 * is new here is the same property through a *mounted shell*, where the frames
 * are real and are produced by a renderer nobody is telling how often to draw.
 *
 * The failure being guarded is specific and quiet. A runtime that settles four
 * scopes faster than the interface draws produces one repaint for eight events,
 * and every event after the first is only visible because the state it left
 * behind is. If a repaint were driven by an event rather than by state — or if
 * a projection dropped a revision it had already been passed — the rail would
 * show the last outcome and lose the three before it, and every frame it drew
 * would still look correct.
 *
 * So the burst is emitted one notification at a time, deliberately: eight
 * separate reasons to re-render, delivered inside a single tick. React batches
 * them and the renderer draws once, which is the coalescing this file is about
 * rather than a coalescing it arranged.
 *
 * The negative control is the second test. A feed that swallows one terminal
 * event produces a frame that is missing exactly that outcome — so the assertion
 * above is one a lost event can fail, rather than one that would pass against
 * any frame with four rows in it.
 */

import { describe, expect, test } from "bun:test";
import { TestRecorder } from "@opentui/core/testing";
import type { ReactNode } from "react";
import type { ScopeEvent, TerminalOutcome } from "../domain/index.ts";
import { scopeEvent } from "../presentation/activity/fixtures.ts";
import { ShellApp } from "./components/shell-app.tsx";
import { mount, type Rendered } from "./harness.tsx";
import { type RuntimeFeed, useRuntimeProjection } from "./runtime-feed.ts";
import type { ThemeRequest } from "./theme/index.ts";
import { known, type ShellModel, unavailable } from "./view-model.ts";

const THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the session." }],
};

/**
 * Wide enough for the rail to be drawn at all.
 *
 * The rail is the one contextual surface, and a standard-width terminal gets
 * none rather than a squeezed one — so a burst asserted at 90 columns would be
 * asserting against a frame the rail is not in.
 */
const WIDE = { columns: 140, rows: 30 } as const;

/**
 * Four scopes, each settling with a different outcome.
 *
 * Different on purpose: four `completed` rows are indistinguishable in a frame,
 * so a fold that kept one and dropped three would draw something that looks
 * exactly like a fold that kept all four. The runtime's own word for each
 * outcome is what the rail prints, so each one is separately observable.
 */
const SETTLING: readonly { readonly scope: string; readonly outcome: TerminalOutcome }[] = [
  { scope: "one", outcome: { kind: "completed" } },
  { scope: "two", outcome: { kind: "failed", effect: "none" } },
  { scope: "three", outcome: { kind: "cancelled", effect: "partial" } },
  { scope: "four", outcome: { kind: "timed-out", effect: "uncertain" } },
];

/** The word the rail prints for each settled scope. */
const SAYS = SETTLING.map((settling) => settling.outcome.kind);

/** Opened, then settled: two events per scope, in the order a runtime emits them. */
function burst(): readonly ScopeEvent[] {
  return SETTLING.flatMap((settling, index) => [
    scopeEvent({ order: index * 2 + 1, kind: "scope.opened", scope: settling.scope }),
    scopeEvent({
      order: index * 2 + 2,
      kind: "scope.terminal",
      scope: settling.scope,
      outcome: settling.outcome,
    }),
  ]);
}

/**
 * A feed a test drives by hand, optionally losing one event on the way in.
 *
 * `swallow` is the negative control and nothing else: it is what a coalescer
 * that dropped a semantic event would look like from the view's side.
 */
function fakeFeed(swallow: (event: ScopeEvent) => boolean = () => false) {
  let events: ScopeEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    feed: {
      events: () => events,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      shutdown: () => null,
    } satisfies RuntimeFeed,
    /** One notification per event, so the batching is the renderer's decision. */
    emit(next: readonly ScopeEvent[]) {
      for (const event of next) {
        if (!swallow(event)) {
          events = [...events, event];
        }
        for (const listener of [...listeners]) {
          listener();
        }
      }
    },
  };
}

/** The shell subscribed to a runtime, which is the tree `./shell.tsx` mounts. */
function Streaming(props: { readonly feed: RuntimeFeed }): ReactNode {
  const runtime = useRuntimeProjection(props.feed);
  return <ShellApp theme={THEME} model={MODEL} onExit={() => {}} activity={runtime.activity} />;
}

function open(feed: RuntimeFeed): Promise<Rendered> {
  return mount(<Streaming feed={feed} />, { shape: WIDE, screenMode: "alternate-screen" });
}

describe("a burst the renderer coalesces", () => {
  test("leaves every semantic terminal event in the frame", async () => {
    const source = fakeFeed();
    using shell = await open(source.feed);
    await shell.frame("Activity");

    // Frames the renderer actually committed, counted by listening to it rather
    // than by inferring from what changed on screen.
    const recorder = new TestRecorder(shell.setup.renderer);
    recorder.rec();
    const events = burst();
    source.emit(events);
    const frame = await shell.frame("timed-out");
    recorder.stop();

    // Every outcome, in the words the runtime used. This is the assertion the
    // whole file exists for: four settlements arrived inside one repaint and all
    // four are still readable.
    for (const says of SAYS) {
      expect({ says, shown: frame.includes(says) }).toEqual({ says, shown: true });
    }

    // And it really was coalesced. Without this the check above would pass just
    // as happily against a renderer that drew a frame per event, which is a
    // different — and much easier — thing to be correct about.
    expect(recorder.recordedFrames.length).toBeLessThan(events.length);
  });

  test("loses exactly the outcome a swallowed event carried", async () => {
    // The negative control. A feed that drops one terminal event is what a lost
    // semantic event looks like from the view's side, and the frame it produces
    // must fail the assertion above rather than satisfy it — otherwise that
    // assertion is passing against any frame with four rows in it.
    // `cancelled` rather than `failed`, and the difference was measured: the
    // status line reports health in its own vocabulary, so the word "failed"
    // is in this frame whether or not the failed scope's settlement arrived.
    // A negative assertion on it would have been an assertion about the health
    // token, passing for a reason unrelated to the event it claims to be about.
    const lost = SETTLING.find((settling) => settling.outcome.kind === "cancelled");
    if (lost === undefined) {
      throw new Error("the burst no longer settles a scope with `cancelled`");
    }
    const source = fakeFeed(
      (event) => event.kind === "scope.terminal" && event.scopeId.includes(lost.scope),
    );
    using shell = await open(source.feed);
    await shell.frame("Activity");

    source.emit(burst());
    const frame = await shell.frame("timed-out");

    // The positive half, so this is not an assertion about an empty frame: the
    // scope whose settlement was swallowed is still shown, still running.
    expect(frame).toContain("running");
    expect(frame).not.toContain(lost.outcome.kind);
    // And nothing else was harmed — the loss is exactly the swallowed one.
    for (const says of SAYS.filter((kind) => kind !== lost.outcome.kind)) {
      expect({ says, shown: frame.includes(says) }).toEqual({ says, shown: true });
    }
  });
});
