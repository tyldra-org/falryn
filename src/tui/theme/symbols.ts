/**
 * Symbols, and the promise that every one of them is redundant.
 *
 * A symbol here never carries meaning on its own. Each status has a word beside
 * it in every view that draws it, and the symbol is a second, faster channel —
 * so a terminal that renders the glyph as a box, a font that lacks it, or a
 * screen reader that skips it all lose speed rather than information.
 *
 * Three repertoires, selected from the domain's `SymbolSupport` and nothing
 * else. This module does not decide what the terminal can draw; `symbolSupportFor`
 * in `src/domain/terminal.ts` already did, from the locale, and a second
 * derivation here would be a second answer.
 *
 * The conservative set exists because "supports Unicode" and "renders every
 * glyph at the width it claims" are different facts. Box-drawing and geometric
 * shapes are close to universal; arrows, braille spinners, and anything
 * emoji-adjacent are not, and a double-width glyph rendered single-width tears
 * every column to its right. Conservative keeps the characters that have been
 * safe for decades.
 */

import type { SymbolSupport } from "../../domain/index.ts";

/** Every symbol the interface can draw. Closed, so a set cannot omit one. */
export const SYMBOL_ROLES = [
  "success",
  "warning",
  "error",
  "informational",
  "pending",
  "cancelled",
  "uncertain",
  "added",
  "removed",
  "modified",
  "conflict",
  "bullet",
  "separator",
  "truncation",
  "focus",
  "collapsed",
  "expanded",
  "caret",
] as const;

export type SymbolRole = (typeof SYMBOL_ROLES)[number];

export type SymbolSet = Readonly<Record<SymbolRole, string>>;

/**
 * The full set.
 *
 * Every character here is single-width and outside the emoji ranges. That is a
 * constraint rather than a preference: an emoji is double-width on some
 * terminals and single on others, and a status column that changes width by
 * terminal is a layout that cannot be aligned.
 */
const UNICODE: SymbolSet = {
  success: "✓",
  warning: "!",
  error: "✗",
  informational: "i",
  pending: "·",
  cancelled: "–",
  uncertain: "?",
  added: "+",
  removed: "-",
  modified: "~",
  conflict: "≠",
  bullet: "•",
  separator: "·",
  truncation: "…",
  focus: "▸",
  collapsed: "▸",
  expanded: "▾",
  // A single-width bar, drawn *before* the character the cursor is on. A
  // reversed cell would be the terminal-native way to show a cursor, but the
  // line primitive styles a whole line rather than a cell — and a caret that is
  // a character survives a monochrome terminal, which a reversed cell drawn with
  // colour alone would not.
  caret: "▏",
};

/**
 * The conservative set.
 *
 * Unicode, but only the parts that predate the ambiguity. Geometric shapes and
 * the ellipsis stay; the check, cross, and not-equal give way to ASCII, because
 * those are the three most likely to arrive as a replacement box on an older
 * terminal or a font without full coverage.
 */
const CONSERVATIVE: SymbolSet = {
  success: "+",
  warning: "!",
  error: "x",
  informational: "i",
  pending: "·",
  cancelled: "-",
  uncertain: "?",
  added: "+",
  removed: "-",
  modified: "~",
  conflict: "!",
  bullet: "•",
  separator: "·",
  truncation: "…",
  focus: ">",
  collapsed: ">",
  expanded: "v",
  caret: "|",
};

/** ASCII, for a terminal whose locale names a charset that is not UTF-8. */
const ASCII: SymbolSet = {
  success: "+",
  warning: "!",
  error: "x",
  informational: "i",
  pending: ".",
  cancelled: "-",
  uncertain: "?",
  added: "+",
  removed: "-",
  modified: "~",
  conflict: "!",
  bullet: "*",
  separator: "|",
  // Three dots rather than one character, and the width difference is the
  // reason the mark is a theme value that `truncateToWidth` is handed: a
  // caller that assumed one cell would overflow by two here.
  truncation: "...",
  focus: ">",
  collapsed: ">",
  expanded: "v",
  caret: "|",
};

export const SYMBOL_SETS = { unicode: UNICODE, conservative: CONSERVATIVE, ascii: ASCII } as const;

export type SymbolRepertoire = keyof typeof SYMBOL_SETS;

/**
 * The repertoire to draw with.
 *
 * `conservative` is not reachable from `SymbolSupport` alone, because the domain
 * derives two values and this is a third. It is selected by the caller — a
 * multiplexer or a remote session is the case that wants it, since both add a
 * layer that may not pass a glyph through unchanged — and the parameter is
 * explicit so nothing here has to guess.
 */
export function symbolsFor(support: SymbolSupport, conservative = false): SymbolSet {
  if (support === "ascii") {
    return ASCII;
  }
  return conservative ? CONSERVATIVE : UNICODE;
}
