/**
 * Making room for an overlay in `split-footer`.
 *
 * The default screen mode gives the live region six rows and keeps everything
 * above it as the terminal's own scrollback. That is right for a transcript-first
 * shell and wrong for an overlay: after the frame's header and status line and
 * the panel's own border, a help overlay had one row to draw twenty commands
 * into — and a terminal does not clip, so the rows drew over each other.
 *
 * Three options existed. A permanently taller footer costs every session
 * scrollback it does not need. Switching to `alternate-screen` while an overlay
 * is open loses the scrollback entirely and makes the mode a moving target.
 * Growing the footer for as long as the overlay is open costs nothing when it is
 * closed, is reversible, and uses the setter OpenTUI provides for exactly this.
 *
 * The growth is bounded by the terminal, not by a constant: an overlay may take
 * most of a tall window and must never take all of a short one, because the rows
 * above the footer are where the user's own scrollback lives.
 */

import { useRenderer } from "@opentui/react";
import { useEffect } from "react";
import { SPLIT_FOOTER_HEIGHT } from "../screen-mode.ts";

/**
 * Rows an overlay would like.
 *
 * Enough for the frame's two rows, a panel border, a dismissal hint, and a dozen
 * commands — the point at which help stops being a truncation notice.
 */
export const OVERLAY_FOOTER_ROWS = 18;

/**
 * The most of the terminal the footer may take.
 *
 * A fraction rather than a subtraction, so a tall terminal keeps meaningful
 * scrollback rather than a fixed two lines of it.
 */
export const MAX_FOOTER_FRACTION = 0.7;

/** The footer height an overlay should get, given the terminal it is in. */
export function overlayFooterHeight(terminalRows: number): number {
  const ceiling = Math.max(SPLIT_FOOTER_HEIGHT, Math.floor(terminalRows * MAX_FOOTER_FRACTION));
  return Math.min(OVERLAY_FOOTER_ROWS, ceiling);
}

/**
 * Grows the footer while an overlay is open and restores it after.
 *
 * A no-op in every mode but `split-footer`: the others already draw into the
 * whole terminal, and setting a footer height on them would be configuring
 * something that does not exist.
 */
export function useOverlayRoom(open: boolean): void {
  const renderer = useRenderer();

  useEffect(() => {
    if (renderer.screenMode !== "split-footer" || !open) {
      return;
    }
    const previous = renderer.footerHeight;
    renderer.footerHeight = overlayFooterHeight(renderer.terminalHeight);
    return () => {
      // Restored on close *and* on unmount. An overlay open when the shell exits
      // must not leave the terminal's scrollback shorter than it found it.
      renderer.footerHeight = previous;
    };
  }, [renderer, open]);
}
