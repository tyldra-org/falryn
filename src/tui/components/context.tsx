/**
 * The frame every component reads from.
 *
 * One context carrying the resolved theme, the layout decision, the viewport,
 * and the text cache. A component asks for what it needs and never for what
 * produced it: there is no colour level here, no symbol repertoire, and no
 * reduced-motion flag, because `resolveTheme` already answered all three and a
 * second consumer of the raw facts would be a second place they are interpreted.
 *
 * The context has no default. A component rendered outside `AppShell` throws
 * with a sentence naming the problem rather than silently drawing with a
 * fallback theme — a fallback would make a missing provider look like a styling
 * bug, found later and somewhere else.
 */

import { createContext, useContext } from "react";
import type { LayoutClass, LayoutDecision, Viewport } from "../layout.ts";
import type { TextCache } from "../text-cache.ts";
import type { Theme } from "../theme/index.ts";

export type Frame = {
  readonly theme: Theme;
  /**
   * The region the tree is actually drawn into.
   *
   * Not the terminal. In `split-footer` the live region is the footer and
   * everything above it is the terminal's own scrollback, so these differ by
   * most of the window — and a component that sized itself to the terminal
   * would lay out a thirty-row frame into six rows of footer.
   */
  readonly viewport: Viewport;
  /**
   * The terminal the user is in.
   *
   * What the layout class is selected from, and the reason the two viewports are
   * both carried. "Is there room for labels" is a question about the window; "how
   * many rows may I draw" is a question about the region. Answering the first
   * from the second makes every split-footer session compact on a terminal with
   * room to spare.
   */
  readonly terminal: Viewport;
  readonly layout: LayoutDecision;
  readonly cache: TextCache;
};

const FrameContext = createContext<Frame | null>(null);

export const FrameProvider = FrameContext.Provider;

export function useFrame(): Frame {
  const frame = useContext(FrameContext);
  if (frame === null) {
    throw new Error("a Falryn interface component was rendered outside AppShell");
  }
  return frame;
}

export function useTheme(): Theme {
  return useFrame().theme;
}

/**
 * The layout class, or `compact` when the viewport is insufficient.
 *
 * A component below the minimum size is not normally rendered at all — `AppShell`
 * shows the minimum-size notice instead — so this exists for the components that
 * *are*, and the narrowest arrangement is the right answer for them.
 */
export function useLayoutClass(): LayoutClass {
  const { layout } = useFrame();
  return layout.kind === "layout" ? layout.class : "compact";
}
