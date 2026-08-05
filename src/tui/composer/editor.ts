/**
 * What is in the composer, and where the cursor is in it.
 *
 * Plain data and a pure reducer, so every editing rule this build promises can
 * be asserted without a terminal — which is the point, because the rules that
 * are easiest to get wrong are the ones a screenshot cannot check.
 *
 * ## Positions are grapheme indices, never code-point offsets
 *
 * The single decision this module is built around. `é` written as `e` plus a
 * combining accent is one character over two code points; a flag is one over
 * two; a family emoji is one over seven joined by zero-width joiners. A cursor
 * counting code points lands *inside* those, and a backspace at that position
 * deletes half a character and leaves a fragment the user never typed. Every
 * index here counts what `graphemes` returns, and the text is rebuilt by joining
 * them, so an index can never name a position that is not a character boundary.
 *
 * The cost is that every operation segments the text. That is affordable because
 * a composer holds a prompt rather than a file, and the alternative — caching a
 * segmentation beside the string — is two representations that disagree the
 * first time one of them is updated without the other.
 *
 * ## Selection is an anchor and a cursor, not a range
 *
 * A range would have to be re-derived on every keystroke to know which end
 * moves. Holding the anchor keeps "extend the selection" a movement of the
 * cursor alone, and makes an empty selection the ordinary case of the two being
 * equal rather than a null that every reader has to handle.
 *
 * ## Nothing here knows about a terminal
 *
 * No width, no wrapping, no renderer, no theme. The control measures; this
 * decides what the text is. A `columns` argument here would make the editing
 * model untestable without deciding a terminal width first.
 */

import { graphemes, wordStarts } from "../../domain/index.ts";

export type EditorState = {
  /** The canonical text. Always the join of its graphemes; never a display form. */
  readonly text: string;
  /** Grapheme index of the cursor, from 0 to the grapheme count. */
  readonly cursor: number;
  /**
   * Grapheme index the selection is anchored at.
   *
   * Equal to the cursor when nothing is selected, which is the resting state and
   * needs no special case anywhere.
   */
  readonly anchor: number;
};

export const EMPTY_EDITOR: EditorState = { text: "", cursor: 0, anchor: 0 };

/** Where a movement goes. Named rather than numeric so a binding reads as intent. */
export const EDITOR_MOTIONS = [
  "left",
  "right",
  "up",
  "down",
  "line-start",
  "line-end",
  "word-left",
  "word-right",
  "document-start",
  "document-end",
] as const;

export type EditorMotion = (typeof EDITOR_MOTIONS)[number];

export type EditorAction =
  /** Ordinary typing, and the destination of an inline paste. Replaces a selection. */
  | { readonly kind: "insert"; readonly text: string }
  /** An explicit newline. Separate from `insert` so submit and newline stay distinct. */
  | { readonly kind: "newline" }
  | { readonly kind: "delete-backward" }
  | { readonly kind: "delete-forward" }
  /** `extend` keeps the anchor, which is what makes shift+motion a selection. */
  | { readonly kind: "move"; readonly motion: EditorMotion; readonly extend: boolean }
  | { readonly kind: "select-all" }
  /**
   * Replaces everything, cursor at the end.
   *
   * How a recalled history entry and a restored draft arrive. A caller that
   * inserted the text instead would append it to whatever was already there.
   */
  | { readonly kind: "set"; readonly text: string }
  /**
   * Puts the cursor at a line and column, collapsing any selection.
   *
   * How a click arrives, and it is deliberately the *same* transition an
   * unextended motion makes: one anchor, one cursor, one selection model. A
   * pointer that introduced a second notion of where the cursor is would be two
   * answers to a question with one, and the first thing to disagree would be a
   * click landing inside a selection made with the keyboard.
   *
   * A position outside the text is clamped rather than refused. The caller is a
   * pointer, and a click below the last line or past the end of one means the
   * nearest position that exists — refusing would make every caller write that
   * rule again.
   */
  | { readonly kind: "place"; readonly at: CursorPosition }
  | { readonly kind: "clear" };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const units = graphemes(state.text);

  switch (action.kind) {
    case "place": {
      const cursor = offsetOf(units, action.at);
      // Not identity when the cursor did not move: a click that lands where the
      // cursor already is still collapses a selection, which is what a user
      // means by clicking inside one.
      if (cursor === state.cursor && state.anchor === state.cursor) {
        return state;
      }
      return { text: state.text, cursor, anchor: cursor };
    }

    case "insert":
      return insert(state, units, action.text);

    case "newline":
      return insert(state, units, "\n");

    case "delete-backward": {
      const selection = selectionOf(state);
      if (selection !== null) {
        return replace(units, selection.start, selection.end, "");
      }
      // Nothing before the start. Returning identity rather than clamping keeps
      // "a keypress that did nothing" distinguishable from one that changed the
      // state to the same value.
      return state.cursor === 0 ? state : replace(units, state.cursor - 1, state.cursor, "");
    }

    case "delete-forward": {
      const selection = selectionOf(state);
      if (selection !== null) {
        return replace(units, selection.start, selection.end, "");
      }
      return state.cursor >= units.length
        ? state
        : replace(units, state.cursor, state.cursor + 1, "");
    }

    case "move": {
      const cursor = moved(units, state.cursor, action.motion);
      // A movement that collapses a selection is still a change even when the
      // cursor did not move: pressing an arrow to dismiss a selection is one of
      // the two things an arrow does.
      if (cursor === state.cursor && (action.extend || state.anchor === state.cursor)) {
        return state;
      }
      return { text: state.text, cursor, anchor: action.extend ? state.anchor : cursor };
    }

    case "select-all":
      return units.length === 0 ? state : { text: state.text, cursor: units.length, anchor: 0 };

    case "set": {
      if (action.text === state.text && state.cursor === state.anchor) {
        return state;
      }
      const end = graphemes(action.text).length;
      return { text: action.text, cursor: end, anchor: end };
    }

    case "clear":
      return state.text === "" && state.cursor === 0 && state.anchor === 0 ? state : EMPTY_EDITOR;
  }
}

/** The selected span as grapheme indices, or `null` when nothing is selected. */
export function selectionOf(
  state: EditorState,
): { readonly start: number; readonly end: number } | null {
  if (state.cursor === state.anchor) {
    return null;
  }
  return {
    start: Math.min(state.cursor, state.anchor),
    end: Math.max(state.cursor, state.anchor),
  };
}

/** The selected text, or the empty string. Sliced by grapheme, so never a fragment. */
export function selectedText(state: EditorState): string {
  const selection = selectionOf(state);
  if (selection === null) {
    return "";
  }
  return graphemes(state.text).slice(selection.start, selection.end).join("");
}

/** Whether the composer has anything worth submitting. Whitespace alone does not count. */
export function hasContent(state: EditorState): boolean {
  return state.text.trim() !== "";
}

/** The number of characters a person would count. Not `text.length`. */
export function lengthOf(state: EditorState): number {
  return graphemes(state.text).length;
}

/**
 * The text as lines, which is what a multiline control draws.
 *
 * Split on the newline the editor itself inserted. Line wrapping is the
 * control's problem and depends on a width this module deliberately does not
 * know.
 */
export function linesOf(state: EditorState): readonly string[] {
  return state.text.split("\n");
}

export type CursorPosition = {
  /** Zero-based line. */
  readonly line: number;
  /** Zero-based grapheme offset within that line. */
  readonly column: number;
};

/** Where the cursor is, in lines and columns rather than in one flat index. */
export function cursorPosition(state: EditorState): CursorPosition {
  return positionOf(graphemes(state.text), state.cursor);
}

/**
 * The grapheme offset a line and column names.
 *
 * The inverse of {@link positionOf}, and it lives beside it for the reason
 * `../composer/geometry.ts` gives about its own pair: two functions computing
 * one relationship in two places disagree eventually, and the disagreement
 * surfaces as a cursor landing somewhere nobody clicked.
 *
 * Both coordinates clamp. A line past the last is the last, and a column past a
 * line's end is its end — which is what a click below the text or to the right
 * of it means.
 */
function offsetOf(units: readonly string[], at: CursorPosition): number {
  const line = Math.max(0, Math.min(at.line, lastLineIndex(units)));
  const bounds = lineBounds(units, line);
  return bounds.start + Math.max(0, Math.min(at.column, bounds.length));
}

function positionOf(units: readonly string[], index: number): CursorPosition {
  let line = 0;
  let column = 0;
  for (let at = 0; at < index && at < units.length; at += 1) {
    if (units[at] === "\n") {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;
  }
  return { line, column };
}

/** The grapheme index at the start of a line, and the line's length in graphemes. */
function lineBounds(
  units: readonly string[],
  line: number,
): { readonly start: number; readonly length: number } {
  let start = 0;
  let current = 0;
  for (let at = 0; at < units.length && current < line; at += 1) {
    if (units[at] === "\n") {
      current += 1;
      start = at + 1;
    }
  }
  let length = 0;
  for (let at = start; at < units.length && units[at] !== "\n"; at += 1) {
    length += 1;
  }
  return { start, length };
}

/** The index of the last line. Zero for text with no newline in it. */
function lastLineIndex(units: readonly string[]): number {
  let lines = 0;
  for (const unit of units) {
    if (unit === "\n") {
      lines += 1;
    }
  }
  return lines;
}

/**
 * Where a motion lands.
 *
 * Vertical movement keeps the column where it can and clamps to the end of the
 * shorter line where it cannot — the ordinary behavior of every editor, and the
 * reason the column is recomputed from the target line rather than carried.
 * Falryn does not keep a "desired column" across repeated vertical moves; a
 * remembered column that survives an edit is a cursor that jumps somewhere the
 * user did not put it.
 */
function moved(units: readonly string[], cursor: number, motion: EditorMotion): number {
  const at = positionOf(units, cursor);

  switch (motion) {
    case "left":
      return Math.max(0, cursor - 1);
    case "right":
      return Math.min(units.length, cursor + 1);
    case "word-left": {
      // The last word start strictly before the cursor. From inside a word that
      // is the word's own start, which is what a user expects from the first
      // press; from the start of one it is the previous word.
      const starts = wordStarts(units.join(""));
      let target = 0;
      for (const start of starts) {
        if (start < cursor) {
          target = start;
        }
      }
      return target;
    }
    case "word-right": {
      // The next word start after the cursor, and the end of the text when
      // there is none — the same rule `right` follows at the buffer's end, so a
      // word motion never stops moving before the text does.
      const starts = wordStarts(units.join(""));
      for (const start of starts) {
        if (start > cursor) {
          return start;
        }
      }
      return units.length;
    }
    case "document-start":
      return 0;
    case "document-end":
      return units.length;
    case "line-start":
      return lineBounds(units, at.line).start;
    case "line-end": {
      const bounds = lineBounds(units, at.line);
      return bounds.start + bounds.length;
    }
    case "up": {
      if (at.line === 0) {
        // The first line's "up" is the start of the document. A movement that
        // did nothing at the top of a composer reads as a stuck key.
        return 0;
      }
      const bounds = lineBounds(units, at.line - 1);
      return bounds.start + Math.min(at.column, bounds.length);
    }
    case "down": {
      if (at.line >= lastLineIndex(units)) {
        // The last line's "down" is the end of the document, for the same reason
        // the first line's "up" is the start of it.
        return units.length;
      }
      const bounds = lineBounds(units, at.line + 1);
      return bounds.start + Math.min(at.column, bounds.length);
    }
  }
}

/** Inserts text at the cursor, replacing a selection when there is one. */
function insert(state: EditorState, units: readonly string[], text: string): EditorState {
  const selection = selectionOf(state);
  const start = selection?.start ?? state.cursor;
  const end = selection?.end ?? state.cursor;
  return replace(units, start, end, text);
}

/**
 * The one place text changes.
 *
 * Every edit is a span replacement, so the cursor lands after the inserted text
 * by construction rather than by each operation computing where it should go.
 */
function replace(units: readonly string[], start: number, end: number, text: string): EditorState {
  const next = [...units.slice(0, start), ...graphemes(text), ...units.slice(end)];
  const cursor = start + graphemes(text).length;
  return { text: next.join(""), cursor, anchor: cursor };
}
