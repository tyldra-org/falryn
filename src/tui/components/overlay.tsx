/**
 * The overlay host.
 *
 * One owner of stacking, sizing, the dismissal surface, and the region contract
 * #26 binds focus containment to. One, because an overlay that sized itself
 * would be an overlay that could cover the status line on a short terminal — and
 * the rule this area cannot break is that an overlay never hides a terminal
 * outcome.
 *
 * Sizing is therefore subtractive rather than proportional: the host is given
 * the rows the frame can spare and never takes the header or the status line's.
 * On a compact terminal an overlay is the whole primary region, which is the
 * documented compact behavior — secondary views *become* routes rather than
 * being squeezed.
 *
 * ## Motion
 *
 * The reveal is a two-step transition rather than a tween: the panel commits at
 * its title height and reaches full height after `theme.motion.reveal`. Under
 * reduced motion that duration is zero and the first committed frame is already
 * final — a mapping rather than a branch, so there is no path where reduced
 * motion *skips* the state change instead of arriving at it immediately.
 *
 * Two steps rather than an interpolated height, and the reason is verification.
 * OpenTUI's timelines advance from the renderer's own frame loop, which a test
 * renderer does not run — so a tweened reveal could not be driven to completion
 * in a test, and an animation nothing can assert reaching its final frame is an
 * overlay that might never open. A transition built from a timer is one whose
 * end state a test can wait for and a reader can predict.
 *
 * It is interruptible: unmounting clears the pending step, so an overlay
 * dismissed mid-reveal stops rather than finishing a transition for something
 * that is gone.
 */

import { type ReactNode, useEffect, useState } from "react";
import { isSingleRegion, primaryRows } from "../layout.ts";
import type { OverlayRoute } from "../view-model.ts";
import { useFrame, useLayoutClass } from "./context.tsx";
import { Line, Panel } from "./primitives.tsx";

/** The most of the viewport an overlay may take, once the frame has its rows. */
export const MAX_OVERLAY_FRACTION = 0.8;

/**
 * Rows the panel occupies before the transition arrives.
 *
 * Its border, which carries the title, and one row inside — which `overlayRows`
 * spends on the way out rather than on content that is about to be resized.
 */
export const OPENING_ROWS = 3;

/** Rows the panel spends on itself. Its border, which carries the title. */
export const PANEL_BORDER_ROWS = 2;

/** The dismissal hint's row. */
export const HINT_ROWS = 1;

export type OverlayRows = {
  /** Rows the route may draw into. Zero means it must not be drawn at all. */
  readonly content: number;
  /** Whether a row remains for the dismissal hint. */
  readonly hint: boolean;
};

/**
 * How a panel of this height is spent, from the outside in.
 *
 * Never clamped up to a minimum, and that is the whole point of the function.
 * The previous arithmetic was `Math.max(1, height - 3)`, which promised the
 * route a row the panel did not contain: at the reveal's three-row step the
 * border takes two and the hint takes the third, so the route's "one" row was
 * the hint's row and the two drew over each other. A budget is a measurement,
 * and a measurement that refuses to return zero is not one.
 *
 * The hint is paid first because it is the way out. Content the panel cannot fit
 * is content the user cannot read either way; a dismissal hint that loses its
 * row is a user who cannot see how to close what just opened.
 *
 * Pure and exported so the contract holds without a frame, in the same way
 * `useReveal` is.
 */
export function overlayRows(height: number): OverlayRows {
  const interior = Math.max(0, height - PANEL_BORDER_ROWS);
  const hint = interior >= HINT_ROWS;
  return { content: Math.max(0, interior - (hint ? HINT_ROWS : 0)), hint };
}

export type OverlayHostProps = {
  readonly route: OverlayRoute;
  /**
   * The content, given the rows it actually has.
   *
   * A function rather than a node because the panel's height is decided here and
   * the content has to respect it. Rendering more rows than the panel has does
   * not clip in a terminal — the lines draw over each other, which is how a
   * 25-command help overlay in a six-row footer became an unreadable smear.
   *
   * May be zero, and a route is still called with it: the host hides the subtree
   * rather than dropping it, so a route that always draws a line cannot overdraw
   * and a route that holds a subscription does not lose it.
   */
  readonly children: (rows: number) => ReactNode;
  /** The words on the dismissal surface. #26 supplies the key that runs it. */
  readonly dismissHint: string;
  readonly title: string;
};

/**
 * Whether the transition has arrived, given how long it takes.
 *
 * `true` from the very first render when the duration is zero — not `false`
 * followed by an effect that corrects it, which would commit one frame of the
 * initial state and make reduced motion a very fast animation rather than no
 * animation. That distinction is the whole acceptance criterion.
 *
 * Exported so the contract is testable on its own rather than only through a
 * frame.
 */
export function useReveal(durationMs: number): boolean {
  const immediate = durationMs <= 0;
  const [arrived, setArrived] = useState(immediate);

  useEffect(() => {
    if (immediate) {
      setArrived(true);
      return;
    }
    const timer = setTimeout(() => setArrived(true), durationMs);
    // Interruptible: an overlay dismissed mid-reveal cancels rather than
    // finishing a transition for something that is gone.
    return () => clearTimeout(timer);
  }, [durationMs, immediate]);

  return arrived;
}

export function OverlayHost(props: OverlayHostProps): ReactNode {
  const frame = useFrame();
  const layoutClass = useLayoutClass();
  const arrived = useReveal(frame.theme.motion.reveal);

  if (props.route.kind === "none") {
    return null;
  }

  // The primary region's own height, from the function the transcript sizes
  // itself with. This used to be `viewport.rows - 2`, a reserve that named the
  // header and the status line and was written before #357 put a composer
  // between them — so on a short terminal the panel was handed rows the composer
  // and its notice were already drawing into, and the status line ended up
  // underneath the panel's bottom border. Two regions subtracting their own
  // idea of the chrome is how a frame overlaps itself; there is one number now.
  const available = Math.max(0, primaryRows(frame.viewport, frame.composerRows));
  // Compact gives the overlay the whole available region: it is a route there,
  // not a panel floating over one.
  const target = isSingleRegion(layoutClass)
    ? available
    : Math.max(0, Math.floor(available * MAX_OVERLAY_FRACTION));
  // The first step is the title bar alone: enough to say something opened,
  // without content appearing at a size it will not stay at.
  const height = arrived ? target : Math.min(target, OPENING_ROWS);

  // A panel is its border and a way out of it. A region shorter than both is a
  // region a panel cannot be drawn into: `Panel` draws two border rows whatever
  // height it is given, so asking for one is asking for an overdraw — which is
  // what the frame did at six rows, the smallest terminal the layout accepts.
  //
  // The route still opened, so something has to say so. One unbordered line
  // carrying the title and the way out is the honest remainder: it fits, it
  // names what is open, and it says how to leave — which drawing nothing at all
  // would not, and the key that opened this would look broken.
  if (target < PANEL_BORDER_ROWS + HINT_ROWS) {
    return target < 1 ? null : (
      <Line color="mutedForeground" typography="muted" maxColumns={frame.viewport.columns}>
        {`${props.title} — ${props.dismissHint}`}
      </Line>
    );
  }

  const rows = overlayRows(height);

  return (
    <Panel strength="focus" surface="overlay" title={props.title} height={height}>
      {/*
       * Hidden rather than unmounted when nothing fits, which is the reveal's
       * first step on every open. A route is not only what it draws — the
       * palette's search subscribes to the keyboard while it is mounted — so
       * unmounting it for the length of the transition would drop whatever was
       * typed into the overlay a key had just opened. `visible` takes the
       * subtree out of both the draw and the layout while React keeps it.
       */}
      <box flexDirection="column" visible={rows.content >= 1}>
        {props.children(rows.content)}
      </box>
      {rows.hint ? (
        <Line color="mutedForeground" typography="muted">
          {props.dismissHint}
        </Line>
      ) : null}
    </Panel>
  );
}
