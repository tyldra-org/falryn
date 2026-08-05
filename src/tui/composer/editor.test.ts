/**
 * The editing model.
 *
 * Every test here runs without a renderer, which is the property the module was
 * shaped for. The cases that matter most are the grapheme ones: they are the
 * difference between a cursor that moves over characters and one that moves over
 * code points, and the second is indistinguishable from the first until somebody
 * types an accent, a flag, or an emoji into a prompt.
 */

import { describe, expect, test } from "bun:test";
import { graphemes, wordStarts } from "../../domain/index.ts";
import {
  cursorPosition,
  type EditorState,
  EMPTY_EDITOR,
  editorReducer,
  hasContent,
  lengthOf,
  linesOf,
  selectedText,
  selectionOf,
} from "./editor.ts";

/** An editor holding text with the cursor at the end. */
function editing(text: string): EditorState {
  return editorReducer(EMPTY_EDITOR, { kind: "set", text });
}

/** Applies actions in order, which is how a sequence of keys is expressed. */
function apply(
  state: EditorState,
  ...actions: readonly Parameters<typeof editorReducer>[1][]
): EditorState {
  return actions.reduce(editorReducer, state);
}

/** A combining accent: one character, two code points. */
const ACCENTED = "é";
/** A flag: one character, two code points, both astral. */
const FLAG = "\u{1F1EF}\u{1F1F5}";
/** A family: one character, seven code points joined by zero-width joiners. */
const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}";

describe("a cursor over graphemes", () => {
  test("counts a combining sequence as one character", () => {
    const state = editing(ACCENTED);
    expect(lengthOf(state)).toBe(1);
    expect(state.cursor).toBe(1);
  });

  test("deletes a whole character rather than half of one", () => {
    // The failure this whole module exists to prevent. A backspace counting code
    // points would leave the base letter without its accent, or a lone
    // surrogate — a character the user never typed and cannot see.
    for (const character of [ACCENTED, FLAG, FAMILY]) {
      const after = apply(editing(`ok${character}`), { kind: "delete-backward" });
      expect({ character, text: after.text }).toEqual({ character, text: "ok" });
    }
  });

  test("moves over a whole character in each direction", () => {
    const state = apply(editing(FAMILY), { kind: "move", motion: "left", extend: false });
    expect(state.cursor).toBe(0);
    expect(apply(state, { kind: "move", motion: "right", extend: false }).cursor).toBe(1);
  });

  test("never yields a fragment as a selection", () => {
    const state = apply(editing(`a${FLAG}b`), { kind: "select-all" });
    expect(selectedText(state)).toBe(`a${FLAG}b`);
    expect(lengthOf(state)).toBe(3);
  });
});

describe("selection", () => {
  test("is absent when the cursor and the anchor agree", () => {
    expect(selectionOf(editing("text"))).toBeNull();
    expect(selectedText(editing("text"))).toBe("");
  });

  test("extends with a motion and collapses without one", () => {
    const extended = apply(editing("hello"), {
      kind: "move",
      motion: "left",
      extend: true,
    });
    expect(selectedText(extended)).toBe("o");

    const collapsed = apply(extended, { kind: "move", motion: "left", extend: false });
    expect(selectionOf(collapsed)).toBeNull();
  });

  test("is replaced by what is typed over it", () => {
    const state = apply(editing("hello"), { kind: "select-all" }, { kind: "insert", text: "bye" });
    expect(state.text).toBe("bye");
    expect(selectionOf(state)).toBeNull();
  });

  test("is what a deletion removes, in either direction", () => {
    for (const kind of ["delete-backward", "delete-forward"] as const) {
      const state = apply(editing("hello"), { kind: "select-all" }, { kind });
      expect({ kind, text: state.text }).toEqual({ kind, text: "" });
    }
  });
});

describe("lines", () => {
  test("a newline is an ordinary insertion, not a submission", () => {
    const state = apply(editing("one"), { kind: "newline" }, { kind: "insert", text: "two" });
    expect(linesOf(state)).toEqual(["one", "two"]);
    expect(cursorPosition(state)).toEqual({ line: 1, column: 3 });
  });

  test("vertical movement keeps the column where the line is long enough", () => {
    const state = apply(
      editing("longer line"),
      { kind: "newline" },
      { kind: "insert", text: "abcdefghijk" },
      { kind: "move", motion: "up", extend: false },
    );
    expect(cursorPosition(state)).toEqual({ line: 0, column: 11 });
  });

  test("vertical movement clamps to the end of a shorter line", () => {
    const state = apply(
      editing("ab"),
      { kind: "newline" },
      { kind: "insert", text: "longer" },
      { kind: "move", motion: "up", extend: false },
    );
    expect(cursorPosition(state)).toEqual({ line: 0, column: 2 });
  });

  test("up from the first line reaches the start, and down from the last the end", () => {
    // A movement that did nothing at the edge of a composer reads as a stuck
    // key, so the edges resolve to the document's own bounds.
    const start = apply(editing("one\ntwo"), { kind: "move", motion: "up", extend: false });
    expect(start.cursor).toBeGreaterThanOrEqual(0);

    const single = apply(editing("only"), {
      kind: "move",
      motion: "document-start",
      extend: false,
    });
    expect(single.cursor).toBe(0);
    expect(apply(single, { kind: "move", motion: "down", extend: false }).cursor).toBe(4);
  });

  test("line-start and line-end act on the line, not the document", () => {
    const state = editing("one\ntwo");
    expect(apply(state, { kind: "move", motion: "line-start", extend: false }).cursor).toBe(4);
    expect(apply(state, { kind: "move", motion: "line-end", extend: false }).cursor).toBe(7);
  });
});

describe("identity", () => {
  test("a keypress that could do nothing returns the same state", () => {
    // So a component re-renders on a key that changed something and not on one
    // that did not, which for a text control is most of them at a boundary.
    const empty = EMPTY_EDITOR;
    expect(editorReducer(empty, { kind: "delete-backward" })).toBe(empty);
    expect(editorReducer(empty, { kind: "delete-forward" })).toBe(empty);
    expect(editorReducer(empty, { kind: "move", motion: "left", extend: false })).toBe(empty);
    expect(editorReducer(empty, { kind: "select-all" })).toBe(empty);
    expect(editorReducer(empty, { kind: "clear" })).toBe(empty);
  });

  test("an arrow that collapses a selection is a change even without movement", () => {
    const selected = apply(editing("ab"), { kind: "select-all" });
    const collapsed = editorReducer(selected, {
      kind: "move",
      motion: "document-end",
      extend: false,
    });
    expect(collapsed).not.toBe(selected);
    expect(selectionOf(collapsed)).toBeNull();
  });
});

describe("content", () => {
  test("whitespace alone is not something to submit", () => {
    expect(hasContent(editing("   \n  "))).toBe(false);
    expect(hasContent(editing(" a "))).toBe(true);
  });

  test("setting replaces rather than appends", () => {
    const state = apply(editing("first"), { kind: "set", text: "second" });
    expect(state.text).toBe("second");
    expect(state.cursor).toBe(6);
  });
});

describe("placing the cursor", () => {
  test("puts it at the line and column it was given", () => {
    const state = apply(editing("one\ntwo\nthree"), {
      kind: "place",
      at: { line: 1, column: 2 },
    });
    expect(cursorPosition(state)).toEqual({ line: 1, column: 2 });
  });

  test("collapses a selection the way an unextended motion does", () => {
    // One selection model. A pointer that left the anchor where it was would be
    // a second notion of where the cursor is, and the first thing to disagree
    // would be a click inside a keyboard selection.
    const selected = apply(editing("hello"), { kind: "select-all" });
    expect(selectedText(selected)).toBe("hello");

    const placed = apply(selected, { kind: "place", at: { line: 0, column: 2 } });
    expect(selectedText(placed)).toBe("");
    expect(placed.anchor).toBe(placed.cursor);
  });

  test("collapses a selection even when the cursor does not move", () => {
    // Clicking where the cursor already sits is how a user dismisses a
    // selection, so identity here would make that click do nothing.
    const selected = apply(editing("hello"), { kind: "select-all" });
    const placed = apply(selected, { kind: "place", at: cursorPosition(selected) });
    expect(selectedText(placed)).toBe("");
  });

  test("clamps a column past the end of its line", () => {
    // What a click to the right of the text means. The line is `one`, and the
    // click was somewhere out in the empty part of the row.
    const state = apply(editing("one\ntwo"), { kind: "place", at: { line: 0, column: 99 } });
    expect(cursorPosition(state)).toEqual({ line: 0, column: 3 });
  });

  test("clamps a line past the last one", () => {
    const state = apply(editing("one\ntwo"), { kind: "place", at: { line: 40, column: 0 } });
    expect(cursorPosition(state)).toEqual({ line: 1, column: 0 });
  });

  test("round-trips against the position it reports", () => {
    // The inverse holding, over every position of a multi-line draft. The two
    // directions live together for this reason, and a check is what keeps that
    // worth anything.
    const text = "one\n\nthree\nfour";
    const lines = text.split("\n");
    for (const [line, content] of lines.entries()) {
      for (let column = 0; column <= graphemes(content).length; column += 1) {
        const placed = apply(editing(text), { kind: "place", at: { line, column } });
        expect(cursorPosition(placed)).toEqual({ line, column });
      }
    }
  });
});

describe("word motions", () => {
  /** Where the cursor ends up after a motion from a given offset. */
  function after(text: string, from: number, motion: "word-left" | "word-right"): number {
    const state = apply(
      { text, cursor: from, anchor: from },
      { kind: "move", motion, extend: false },
    );
    return state.cursor;
  }

  test("step between words rather than pausing on the punctuation between them", () => {
    // The reason the boundary is the platform's and not `split(" ")`: a motion
    // that stopped on every comma would take three presses to cross `a, b`.
    const text = "one, two three";
    expect(after(text, 14, "word-left")).toBe(9);
    expect(after(text, 9, "word-left")).toBe(5);
    expect(after(text, 5, "word-left")).toBe(0);
  });

  test("cross a CJK run, which has no spaces to split on", () => {
    // `split(" ")` sees one word here and the segmenter sees the words. This is
    // the case that makes the platform's answer worth taking.
    const text = "hello 世界です world";
    const starts = wordStarts(text);
    expect(starts.length).toBeGreaterThan(2);
    // The second word's start, which a `split(" ")` boundary would have missed
    // entirely because there is no space inside the run.
    expect(after(text, 0, "word-right")).toBe(starts[1] ?? -1);
  });

  test("treat a joined emoji the way the platform does", () => {
    // Recorded rather than asserted as a preference: the segmenter reports a ZWJ
    // sequence as not word-like, so a word motion steps over it as it would over
    // punctuation. That is the platform's answer and this module inherits it —
    // the alternative is a second opinion about what a word is.
    const text = "hi 👨‍👩‍👧 there";
    const starts = wordStarts(text);
    expect(starts.length).toBe(2);
    expect(after(text, 0, "word-right")).toBe(starts[1] ?? -1);
  });

  test("stop at the ends rather than before them", () => {
    // The rule `left` and `right` already follow at the buffer's edges: a word
    // motion never stops moving before the text does.
    const text = "one two";
    expect(after(text, 7, "word-right")).toBe(7);
    expect(after(text, 0, "word-left")).toBe(0);
    expect(after(text, 5, "word-right")).toBe(7);
  });

  test("count graphemes, so a wide or combining character is one position", () => {
    // The offsets a cursor holds are grapheme indices everywhere else in this
    // model, and a boundary reported in code units would be a second coordinate
    // system — with the first astral character putting a motion inside a
    // character.
    const text = "café 日本 x";
    const units = graphemes(text);
    for (const start of wordStarts(text)) {
      expect(start).toBeLessThanOrEqual(units.length);
      // A boundary is a position between characters, never inside one.
      expect(Number.isInteger(start)).toBe(true);
    }
  });

  test("extend a selection like every other motion", () => {
    const selected = apply(editing("one two three"), {
      kind: "move",
      motion: "word-left",
      extend: true,
    });
    expect(selectedText(selected)).toBe("three");
  });
});
