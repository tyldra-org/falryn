/**
 * A row, resolved to something a terminal can be told to draw.
 *
 * `./rows.ts` decides *what* a block says; this decides how that reads once a
 * theme has answered what a token is worth on this terminal. It stays a pure
 * function so the answer can be asserted without a renderer, which is the same
 * reason the rows themselves are pure — and it is what lets the live footer and
 * the terminal's own scrollback be drawn from one decision instead of two.
 *
 * Two rules are load-bearing.
 *
 * **A status is a symbol and a word.** Resolved from `STATUS_PRESENTATION`, the
 * same table `StatusMark` reads, so a status committed to scrollback carries the
 * glyph *and* the label a monochrome terminal needs. A second composition here
 * would be a second answer, and the reader would only find the disagreement by
 * comparing the footer against their own scroll history.
 *
 * **Every line is sanitized, not only the ones flagged untrusted.** A row's
 * `untrusted` flag says where the text came from; it does not say where the text
 * is going. These lines go to the terminal's scrollback, which is the one
 * destination Falryn cannot repaint, so a forged escape sequence there is
 * permanent. Sanitizing text that was already safe costs a pass and removes the
 * whole class of failure.
 */

import { sanitizeTerminalText, truncateToWidth } from "../../domain/index.ts";
import { STATUS_PRESENTATION, type Theme, textAttributes } from "../theme/index.ts";
import type { TranscriptRow } from "./rows.ts";

/**
 * One line, ready to be handed to a renderable.
 *
 * A resolved colour may be `null`, and that is passed through rather than
 * substituted: omitting the colour is what makes a monochrome terminal actually
 * monochrome, and a grey stand-in would let colour-only meaning survive into the
 * one terminal that cannot carry it.
 */
export type DrawableLine = {
  /** Indent applied, content sanitized, and the whole line fitted to the width. */
  readonly text: string;
  readonly color: string | null;
  /** OpenTUI's attribute bit field, from the theme's own mapping. */
  readonly attributes: number;
};

/**
 * The lines a set of rows draws, at a given width.
 *
 * The indent is spent from the same budget as the text, so a deeply indented
 * line is truncated to what is left rather than pushed past the edge. Rows are
 * already wrapped by `rowsForBlock`; what happens here is fitting, which is the
 * last thing that can make a line wider than the terminal.
 */
export function drawableLines(
  rows: readonly TranscriptRow[],
  theme: Theme,
  columns: number,
): readonly DrawableLine[] {
  return rows.map((row) => drawableLine(row, theme, columns));
}

export function drawableLine(row: TranscriptRow, theme: Theme, columns: number): DrawableLine {
  const room = Math.max(1, columns - row.indent);
  const resolved = row.kind === "status" ? fromStatus(row, theme) : fromText(row);
  const text = truncateToWidth(sanitizeTerminalText(resolved.text), room, theme.marks.truncation);
  return {
    text: `${" ".repeat(row.indent)}${text}`,
    color: theme.color(resolved.color),
    attributes: textAttributes(theme.typography(resolved.typography)),
  };
}

type Resolved = {
  readonly text: string;
  readonly color: Parameters<Theme["color"]>[0];
  readonly typography: Parameters<Theme["typography"]>[0];
};

function fromStatus(row: Extract<TranscriptRow, { kind: "status" }>, theme: Theme): Resolved {
  const presentation = STATUS_PRESENTATION[row.status];
  return {
    text: `${theme.symbol(presentation.symbol)} ${row.label}`,
    color: presentation.token,
    typography: "emphasis",
  };
}

function fromText(row: Extract<TranscriptRow, { kind: "text" }>): Resolved {
  return { text: row.text, color: row.color, typography: row.typography };
}
