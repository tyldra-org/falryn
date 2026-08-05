/**
 * Where a position in the draft is on the screen, and which position a screen
 * cell is.
 *
 * One relationship, two directions, one module — and that is the whole reason
 * this file exists rather than a function beside each caller. #386 landed the
 * outward direction inside the component, with the reasoning attached: the
 * cursor's column is a *cell* offset and not a grapheme count, because
 * `displayWidth` is the measurement the layout and the truncation were decided
 * with. The pointer's mapping is the same arithmetic run backwards. Two
 * functions computing one relationship in two files disagree eventually — on a
 * wide glyph, on an emoji sequence, or the first time somebody edits one of
 * them — and the disagreement surfaces as a cursor that lands one cell from
 * where it was clicked, which nobody traces back to arithmetic.
 *
 * Pure. No renderer, no React, no pointer, and no editing: these functions
 * answer *where*, and the caller decides what to do about it.
 *
 * ## Cells and columns are different numbers
 *
 * A column is a grapheme index — what the editing model counts, so that an
 * index can never name a position that is not a character boundary. A cell is
 * a terminal column. `日本` is two graphemes and four cells; a combining
 * sequence is one grapheme, several code points, and one cell. Confusing the
 * two is the defect #386 closed one layer up, and running the arithmetic
 * backwards is where it would come back.
 */

import { displayWidth, graphemes } from "../../domain/index.ts";

/** A line the composer drew, and where it sits in the draft. */
export type DrawnLine = {
  /** Zero-based line number in the draft, never an offset into the window. */
  readonly number: number;
  readonly text: string;
};

/** A position in the draft: a line, and a grapheme column within it. */
export type DraftPosition = {
  readonly line: number;
  readonly column: number;
};

/** A cell in the terminal, in the space `screenX` and `screenY` report. */
export type ScreenCell = {
  readonly column: number;
  readonly row: number;
};

/** Where the composer's drawn lines begin, and what they are. */
export type DrawnRegion = {
  readonly lines: readonly DrawnLine[];
  /** The cell the first character of every drawn line occupies. */
  readonly originColumn: number;
  /** The row the first drawn line occupies. */
  readonly originRow: number;
};

/**
 * Cells from the start of `text` to grapheme `column`.
 *
 * The slice is taken from graphemes rather than from a string index for the
 * reason the editing model gives: a grapheme offset does not correspond to a
 * code-unit index at all, and cutting at one would split a surrogate pair.
 *
 * A column past the end answers the width of the whole line rather than
 * throwing — a caller asking where the end is should be told, not corrected.
 */
export function cellOfColumn(text: string, column: number): number {
  const units = graphemes(text);
  const bounded = Math.max(0, Math.min(column, units.length));
  return displayWidth(units.slice(0, bounded).join(""));
}

/**
 * The grapheme column a cell falls in.
 *
 * ## Which edge a wide glyph resolves to
 *
 * Stated rather than incidental, because it is the one decision here a reader
 * would otherwise have to derive from the loop. A cell inside a grapheme
 * resolves to that grapheme's **start**: clicking either half of `日` puts the
 * position before it, never between its two cells — a position between them
 * does not exist in the draft, and inventing one would let a click produce a
 * column the editing model can never hold.
 *
 * That choice is also what makes the round trip exact. `cellOfColumn` answers a
 * grapheme's starting cell, so mapping that cell back returns the column it
 * came from, for every column of every line — which is asserted rather than
 * reasoned about.
 *
 * A cell past the line's text resolves to the end of the line. Clicking past
 * the end of a sentence puts the cursor at the end of it, which is what every
 * text field does and what a caller would otherwise have to special-case.
 */
export function columnOfCell(text: string, cell: number): number {
  if (cell <= 0) {
    return 0;
  }
  const units = graphemes(text);
  let cells = 0;
  for (const [column, unit] of units.entries()) {
    const width = displayWidth(unit);
    // `cell` lands inside this grapheme when it has not reached the next one's
    // start. A zero-width grapheme never claims a cell, so it cannot swallow a
    // position that belongs to the character it decorates.
    if (width > 0 && cell < cells + width) {
      return column;
    }
    cells += width;
  }
  return units.length;
}

/** The cell a draft position occupies, or `null` when that line is not drawn. */
export function cellOfPosition(lines: readonly DrawnLine[], at: DraftPosition): number | null {
  const drawn = lines.find((line) => line.number === at.line);
  return drawn === undefined ? null : cellOfColumn(drawn.text, at.column);
}

/**
 * The draft position a screen cell names.
 *
 * A row outside the drawn lines resolves to the nearest drawn one rather than
 * to nothing. The composer draws a bounded window anchored to the cursor, so a
 * row above or below it is a real click on a real region — a drag that leaves
 * the top of the composer means "the first line", and returning nothing would
 * make every caller write that rule again.
 *
 * `lines` being empty is the one case with no answer, and it is reported as
 * `null` rather than as line zero: a composer that has drawn nothing has no
 * position to name, and answering zero would be a position in a draft that is
 * not on screen.
 */
export function positionOfCell(region: DrawnRegion, cell: ScreenCell): DraftPosition | null {
  const { lines, originColumn, originRow } = region;
  if (lines.length === 0) {
    return null;
  }

  const row = Math.max(0, Math.min(cell.row - originRow, lines.length - 1));
  const drawn = lines[row];
  if (drawn === undefined) {
    return null;
  }
  return { line: drawn.number, column: columnOfCell(drawn.text, cell.column - originColumn) };
}
