/**
 * The rail's fold, and the resubscription it exists for.
 *
 * The acceptance criterion this file owns is that a view can resume from a
 * durable cursor without restarting the runtime. That is asserted two ways: the
 * fold's properties — idempotent under replay, and a suffix applied to a
 * projection equals the whole sequence folded from nothing — and structurally,
 * because nothing this module can reach is a runtime.
 */

import { describe, expect, test } from "bun:test";
import { everyOutcome, running, scopeEvent, settled } from "./fixtures.ts";
import {
  ACTIVITY_PROJECTION_GENERATION,
  type ActivityProjection,
  EMPTY_ACTIVITY,
  initialActivityCursor,
  liveEntries,
  MAX_SETTLED_ENTRIES,
  reduceActivity,
  resubscribeActivity,
  resumableActivity,
  settledEntries,
} from "./reducer.ts";

/** The whole sequence, folded from nothing. The answer a resume must match. */
function foldAll(events: Parameters<typeof reduceActivity>[1]): ActivityProjection {
  return reduceActivity(EMPTY_ACTIVITY, events);
}

describe("folding scope events", () => {
  test("keeps one entry per scope, however many events it produced", () => {
    const projection = foldAll(settled(0, "one", { kind: "completed" }));
    expect(projection.entries.length).toBe(1);
    expect(projection.entries[0]?.lifecycle).toBe("terminal");
  });

  test("advances the cursor to the last applied order", () => {
    const projection = foldAll([...running(0, "a"), ...running(1, "b")]);
    expect(projection.cursor.lastAppliedOrder).toBe(1);
    expect(projection.cursor.generation).toBe(ACTIVITY_PROJECTION_GENERATION);
  });

  test("separates live work from settled work", () => {
    const projection = foldAll([
      ...running(0, "live"),
      ...settled(1, "done", { kind: "completed" }),
    ]);
    expect(liveEntries(projection).length).toBe(1);
    expect(settledEntries(projection).length).toBe(1);
  });

  test("returns identity when nothing applied", () => {
    // So a frame that folded the same events again does not re-render the tree.
    const projection = foldAll(running(0, "a"));
    expect(reduceActivity(projection, running(0, "a"))).toBe(projection);
    expect(reduceActivity(projection, [])).toBe(projection);
  });

  test("never lets a later event downgrade an observed uncertainty", () => {
    // The rule the scope tree itself applies. A progress report arriving after
    // an uncertain effect must not report the work as clean.
    const projection = foldAll([
      scopeEvent({ order: 0, kind: "scope.opened", scope: "a" }),
      scopeEvent({ order: 1, kind: "scope.effect.recorded", scope: "a", effect: "uncertain" }),
      scopeEvent({ order: 2, kind: "scope.effect.recorded", scope: "a", effect: "none" }),
    ]);
    expect(projection.entries[0]?.effect).toBe("uncertain");
  });
});

describe("resubscribing", () => {
  test("a suffix applied to a projection equals the whole sequence", () => {
    // The property a resume depends on. A view that dropped and came back must
    // end up with what it would have had if it never left.
    const events = [...running(0, "a"), ...settled(1, "b", { kind: "failed", effect: "none" })];
    const prefix = foldAll(events.slice(0, 1));
    const resumed = reduceActivity(prefix, events.slice(1));

    expect(resumed.entries).toEqual(foldAll(events).entries);
    expect(resumed.cursor.lastAppliedOrder).toBe(foldAll(events).cursor.lastAppliedOrder);
  });

  test("is idempotent when the stream overlaps what was already applied", () => {
    // A resubscribing view cannot know exactly where the stream restarts, so an
    // overlap is skipped rather than refused — the caller cannot compute the
    // slice this would make it responsible for.
    const events = everyOutcome();
    const once = foldAll(events);
    const twice = reduceActivity(once, events);
    expect(twice).toBe(once);
  });

  test("resumes from a cursor of this generation without rebuilding", () => {
    const events = [...running(0, "a"), ...running(1, "b")];
    const resumed = resubscribeActivity(
      { lastAppliedOrder: 0, generation: ACTIVITY_PROJECTION_GENERATION },
      events,
    );
    expect(resumed.rebuilt).toBe(false);
    // Only the second event was applied, so only the second scope is present.
    expect(resumed.projection.entries.length).toBe(1);
    expect(resumed.projection.cursor.lastAppliedOrder).toBe(1);
  });

  test("rebuilds rather than resuming across a generation change", () => {
    // Conservative on purpose, and in both directions: a newer cursor is as
    // unusable as an older one, because it names a position in output this build
    // does not produce. Guessing which is compatible is how a downgrade renders
    // a rail that never existed.
    const events = [...running(0, "a"), ...running(1, "b")];
    for (const generation of [
      ACTIVITY_PROJECTION_GENERATION - 1,
      ACTIVITY_PROJECTION_GENERATION + 1,
    ]) {
      const resumed = resubscribeActivity({ lastAppliedOrder: 0, generation }, events);
      expect({ generation, rebuilt: resumed.rebuilt }).toEqual({ generation, rebuilt: true });
      expect({ generation, entries: resumed.projection.entries.length }).toEqual({
        generation,
        entries: 2,
      });
    }
  });

  test("an initial cursor carries this build's generation and resumes", () => {
    const cursor = initialActivityCursor();
    expect(resumableActivity(cursor)).toBe(true);
    expect(resubscribeActivity(cursor, running(0, "a")).rebuilt).toBe(false);
  });
});

describe("bounds", () => {
  test("keeps every live entry and a bounded tail of settled ones", () => {
    // Live work is never evicted. A rail that dropped a running operation to
    // make room for a finished one would hide the thing it exists to show.
    const events = [
      ...running(0, "live"),
      ...Array.from({ length: MAX_SETTLED_ENTRIES + 5 }, (_unused, index) =>
        settled(index * 2 + 2, `done-${index}`, { kind: "completed" }),
      ).flat(),
    ];
    const projection = foldAll(events);

    expect(liveEntries(projection).length).toBe(1);
    expect(settledEntries(projection).length).toBe(MAX_SETTLED_ENTRIES);
    expect(projection.droppedSettled).toBe(5);
  });

  test("reports what it dropped rather than presenting a truncated list", () => {
    const events = Array.from({ length: MAX_SETTLED_ENTRIES + 3 }, (_unused, index) =>
      settled(index * 2, `done-${index}`, { kind: "completed" }),
    ).flat();
    expect(foldAll(events).droppedSettled).toBe(3);
  });

  test("evicts the oldest settled entries first", () => {
    const events = Array.from({ length: MAX_SETTLED_ENTRIES + 1 }, (_unused, index) =>
      settled(index * 2, `done-${index}`, { kind: "completed" }),
    ).flat();
    const keys = foldAll(events).entries.map((entry) => entry.key);
    expect(keys).not.toContain("scope:scope-done-0");
    expect(keys).toContain(`scope:scope-done-${MAX_SETTLED_ENTRIES}`);
  });
});
