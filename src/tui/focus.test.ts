/**
 * Focus as a logical path.
 *
 * The round trips are what matter: focus has to survive an overlay opening and
 * closing, a resize, and an item disappearing. Each of those is cheap to break
 * and expensive to notice, because nothing fails — focus simply ends up
 * somewhere the user did not put it, and they discover that by pressing a key
 * that does the wrong thing.
 */

import { describe, expect, test } from "bun:test";
import {
  containFocus,
  createFocusModel,
  EMPTY_FOCUS,
  focusedRegion,
  focusNext,
  focusPrevious,
  focusRegion,
  isContained,
  releaseFocus,
  withRegions,
} from "./focus.ts";

const FRAME = [
  { id: "header", label: "workspace header" },
  { id: "primary", label: "main region" },
  { id: "status", label: "status line" },
];

const OVERLAY = [{ id: "overlay.help", label: "help" }];

describe("a new model", () => {
  test("focuses the first region in reading order", () => {
    expect(createFocusModel(FRAME).focused).toBe("header");
  });

  test("focuses nothing when nothing is reachable", () => {
    expect(createFocusModel([]).focused).toBe(null);
    expect(EMPTY_FOCUS.focused).toBe(null);
  });

  test("names the focused region, so an indicator is not colour-only", () => {
    // The label is the point: "you are in the workspace header" is the only
    // thing an interface can say to someone who cannot see a highlight.
    expect(focusedRegion(createFocusModel(FRAME))?.label).toBe("workspace header");
  });
});

describe("moving", () => {
  test("follows reading order and wraps", () => {
    // Wrapping rather than stopping: a terminal has no scroll bar to show you
    // reached the last region, so stopping reads as the key having failed.
    let model = createFocusModel(FRAME);
    expect(model.focused).toBe("header");
    model = focusNext(model);
    expect(model.focused).toBe("primary");
    model = focusNext(focusNext(model));
    expect(model.focused).toBe("header");
  });

  test("wraps backwards too", () => {
    expect(focusPrevious(createFocusModel(FRAME)).focused).toBe("status");
  });

  test("is a no-op when nothing is reachable", () => {
    expect(focusNext(createFocusModel([])).focused).toBe(null);
    expect(focusPrevious(createFocusModel([])).focused).toBe(null);
  });

  test("recovers when focus is not in its own order", () => {
    // After a removal the focused id can be stale. Moving must land somewhere
    // reachable rather than staying nowhere.
    const stale = { ...createFocusModel(FRAME), focused: "gone" };
    expect(focusNext(stale).focused).toBe("header");
    expect(focusPrevious(stale).focused).toBe("status");
  });

  test("focuses a named region, and ignores one that is not reachable", () => {
    const model = createFocusModel(FRAME);
    expect(focusRegion(model, "status").focused).toBe("status");
    expect(focusRegion(model, "nowhere")).toBe(model);
  });
});

describe("containment", () => {
  test("makes only the overlay reachable and remembers where focus was", () => {
    // Not merely visually in front: out of tab order entirely, which is what
    // "background regions do not consume keys" means when someone presses Tab.
    const contained = containFocus(focusRegion(createFocusModel(FRAME), "primary"), OVERLAY);
    expect(contained.order.map((region) => region.id)).toEqual(["overlay.help"]);
    expect(contained.focused).toBe("overlay.help");
    expect(isContained(contained)).toBe(true);
  });

  test("returns focus to where it came from", () => {
    // The round trip, which is the whole contract.
    const before = focusRegion(createFocusModel(FRAME), "primary");
    const after = releaseFocus(containFocus(before, OVERLAY), FRAME);
    expect(after.focused).toBe("primary");
    expect(isContained(after)).toBe(false);
  });

  test("nests, so an overlay over an overlay restores both", () => {
    // A single remembered slot would lose the outer one.
    const base = focusRegion(createFocusModel(FRAME), "status");
    const first = containFocus(base, OVERLAY);
    const second = containFocus(first, [{ id: "overlay.palette", label: "palette" }]);

    const back = releaseFocus(second, OVERLAY);
    expect(back.focused).toBe("overlay.help");
    expect(releaseFocus(back, FRAME).focused).toBe("status");
  });

  test("falls back when the region focus came from is gone", () => {
    // The remembered id is a preference, not a guarantee: the overlay may have
    // been open while a resize removed the region behind it.
    const before = focusRegion(createFocusModel(FRAME), "primary");
    const contained = containFocus(before, OVERLAY);
    const survivors = [{ id: "header", label: "workspace header" }];
    expect(releaseFocus(contained, survivors).focused).toBe("header");
  });

  test("releases to nothing when nothing survived", () => {
    const contained = containFocus(createFocusModel(FRAME), OVERLAY);
    expect(releaseFocus(contained, []).focused).toBe(null);
  });
});

describe("regions changing underneath", () => {
  test("keeps focus where it is when its region survived", () => {
    // A resize must not move focus. This is the common case and the one a user
    // would notice immediately.
    const model = focusRegion(createFocusModel(FRAME), "primary");
    expect(withRegions(model, FRAME).focused).toBe("primary");
    expect(withRegions(model, [...FRAME].reverse()).focused).toBe("primary");
  });

  test("moves to the region that took its place", () => {
    // The documented neighbour: the one now at the same position in reading
    // order. Jumping to the first region would send someone back to the top of
    // the interface every time something below them disappeared.
    const model = focusRegion(createFocusModel(FRAME), "primary");
    const without = [FRAME[0] as never, FRAME[2] as never];
    expect(withRegions(model, without).focused).toBe("status");
  });

  test("falls to the last region when the removed one was at the end", () => {
    const model = focusRegion(createFocusModel(FRAME), "status");
    expect(withRegions(model, FRAME.slice(0, 2)).focused).toBe("primary");
  });

  test("focuses nothing when nothing is left", () => {
    const model = createFocusModel(FRAME);
    expect(withRegions(model, []).focused).toBe(null);
  });

  test("does not disturb what containment remembered", () => {
    // A resize while an overlay is open must still restore correctly after.
    const contained = containFocus(focusRegion(createFocusModel(FRAME), "primary"), OVERLAY);
    const resized = withRegions(contained, OVERLAY);
    expect(releaseFocus(resized, FRAME).focused).toBe("primary");
  });
});
