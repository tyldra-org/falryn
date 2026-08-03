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
import { isSingleRegion } from "../layout.ts";
import type { OverlayRoute } from "../view-model.ts";
import { useFrame, useLayoutClass } from "./context.tsx";
import { Line, Panel } from "./primitives.tsx";

/**
 * Rows the frame keeps for itself whatever an overlay wants.
 *
 * The header and the status line. Named as a constant rather than subtracted
 * inline because it is a promise — "an overlay never hides a terminal outcome"
 * is exactly this number being reserved.
 */
export const RESERVED_FRAME_ROWS = 2;

/** The most of the viewport an overlay may take, once the frame has its rows. */
export const MAX_OVERLAY_FRACTION = 0.8;

/** Rows the panel occupies before the transition arrives: its border and title. */
export const OPENING_ROWS = 3;

export type OverlayHostProps = {
  readonly route: OverlayRoute;
  /**
   * The content, given the rows it actually has.
   *
   * A function rather than a node because the panel's height is decided here and
   * the content has to respect it. Rendering more rows than the panel has does
   * not clip in a terminal — the lines draw over each other, which is how a
   * 25-command help overlay in a six-row footer became an unreadable smear.
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
  const { theme, viewport } = useFrame();
  const layoutClass = useLayoutClass();
  const arrived = useReveal(theme.motion.reveal);

  if (props.route.kind === "none") {
    return null;
  }

  const available = Math.max(1, viewport.rows - RESERVED_FRAME_ROWS);
  // Compact gives the overlay the whole available region: it is a route there,
  // not a panel floating over one.
  const target = isSingleRegion(layoutClass)
    ? available
    : Math.max(1, Math.floor(available * MAX_OVERLAY_FRACTION));
  // The first step is the title bar alone: enough to say something opened,
  // without content appearing at a size it will not stay at.
  const height = arrived ? target : Math.min(target, OPENING_ROWS);

  // Two rows for the panel's own border, one for the dismissal hint.
  const contentRows = Math.max(1, height - 3);

  return (
    <Panel strength="focus" surface="overlay" title={props.title} height={height}>
      {props.children(contentRows)}
      <Line color="mutedForeground" typography="muted">
        {props.dismissHint}
      </Line>
    </Panel>
  );
}
