/**
 * What the reader has done, as a sequence of values.
 *
 * The reducer is where "no persisted scroll state" and "expansion holds keys,
 * never content" are enforced, so both are asserted here rather than described.
 */

import { describe, expect, test } from "bun:test";
import { everyBlockKind } from "../../presentation/transcript/fixtures.ts";
import {
  INITIAL_TRANSCRIPT_STATE,
  keysOf,
  neighbourKey,
  type TranscriptSurfaceAction,
  type TranscriptSurfaceState,
  transcriptSurfaceReducer,
} from "./surface.ts";
import { LATEST } from "./window.ts";

function run(
  actions: readonly TranscriptSurfaceAction[],
  from: TranscriptSurfaceState = INITIAL_TRANSCRIPT_STATE,
): TranscriptSurfaceState {
  return actions.reduce(transcriptSurfaceReducer, from);
}

const KEYS = keysOf(everyBlockKind());

describe("the resting state", () => {
  test("follows the latest and has nothing open or selected", () => {
    expect(INITIAL_TRANSCRIPT_STATE.anchor).toEqual(LATEST);
    expect(INITIAL_TRANSCRIPT_STATE.expanded.size).toBe(0);
    expect(INITIAL_TRANSCRIPT_STATE.selected).toBe(null);
  });
});

describe("expansion", () => {
  test("toggles, and selects what it opened", () => {
    // Opening without selecting would leave a block the reader cannot collapse
    // without navigating back to it.
    const opened = run([{ kind: "toggle-expansion", key: "a" }]);
    expect(opened.expanded.has("a")).toBe(true);
    expect(opened.selected).toBe("a");

    const closed = run([{ kind: "toggle-expansion", key: "a" }], opened);
    expect(closed.expanded.has("a")).toBe(false);
  });

  test("holds keys and never content", () => {
    // The retention rule. Full content is read from the projection every time it
    // is drawn, so a revised block cannot be rendered from a copy this kept.
    const state = run([
      { kind: "toggle-expansion", key: "a" },
      { kind: "toggle-expansion", key: "b" },
    ]);
    for (const key of state.expanded) {
      expect(typeof key).toBe("string");
    }
    expect([...state.expanded]).toEqual(["a", "b"]);
  });

  test("keeps several blocks open at once", () => {
    const state = run([
      { kind: "toggle-expansion", key: "a" },
      { kind: "toggle-expansion", key: "b" },
      { kind: "toggle-expansion", key: "c" },
      { kind: "toggle-expansion", key: "b" },
    ]);
    expect([...state.expanded]).toEqual(["a", "c"]);
  });
});

describe("reconciling with a rebuilt projection", () => {
  test("drops expansions for blocks that are gone", () => {
    // A key nothing resolves would be an expansion the surface could never
    // draw and the reader could never close.
    const state = run([
      { kind: "toggle-expansion", key: "gone" },
      { kind: "toggle-expansion", key: KEYS[0] ?? "" },
      { kind: "reconcile", keys: KEYS },
    ]);
    expect(state.expanded.has("gone")).toBe(false);
    expect(state.expanded.has(KEYS[0] ?? "")).toBe(true);
  });

  test("moves a selection that no longer exists to the latest block", () => {
    const state = run([
      { kind: "select", key: "gone" },
      { kind: "reconcile", keys: KEYS },
    ]);
    expect(state.selected).toBe(KEYS.at(-1) ?? null);
  });

  test("leaves a selection that survived exactly where it was", () => {
    const state = run([
      { kind: "select", key: KEYS[2] ?? "" },
      { kind: "reconcile", keys: KEYS },
    ]);
    expect(state.selected).toBe(KEYS[2] ?? "");
  });

  test("selects nothing when the transcript became empty", () => {
    const state = run([
      { kind: "select", key: KEYS[0] ?? "" },
      { kind: "reconcile", keys: [] },
    ]);
    expect(state.selected).toBe(null);
    expect(state.expanded.size).toBe(0);
  });

  test("never touches the anchor", () => {
    // Arriving blocks do not move a reader. The anchor changes only when a
    // command changes it.
    const pinned = { kind: "pinned", key: "b", rowOffset: 2 } as const;
    const state = run([
      { kind: "anchor", anchor: pinned },
      { kind: "reconcile", keys: KEYS },
    ]);
    expect(state.anchor).toEqual(pinned);
  });
});

describe("moving the selection", () => {
  test("walks in order and stops at each end rather than wrapping", () => {
    // Wrapping would carry a reader across the whole history on a keypress
    // meant to move them one entry.
    expect(neighbourKey(KEYS, KEYS[0] ?? null, -1)).toBe(KEYS[0] ?? null);
    expect(neighbourKey(KEYS, KEYS[0] ?? null, 1)).toBe(KEYS[1] ?? null);
    expect(neighbourKey(KEYS, KEYS.at(-1) ?? null, 1)).toBe(KEYS.at(-1) ?? null);
  });

  test("starts at an end when nothing is selected", () => {
    expect(neighbourKey(KEYS, null, 1)).toBe(KEYS[0] ?? null);
    expect(neighbourKey(KEYS, null, -1)).toBe(KEYS.at(-1) ?? null);
  });

  test("recovers when the selection is not in the list", () => {
    expect(neighbourKey(KEYS, "gone", 1)).toBe(KEYS[0] ?? null);
  });

  test("has nothing to select in an empty transcript", () => {
    expect(neighbourKey([], null, 1)).toBe(null);
    expect(neighbourKey([], "a", -1)).toBe(null);
  });
});

describe("block keys", () => {
  test("are the projection's own identities, in order", () => {
    // Derived from the anchor rather than assigned, so two revisions of one
    // block are one key.
    expect(KEYS.length).toBe(everyBlockKind().length);
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });
});
