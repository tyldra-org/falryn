/**
 * What the reader has done to the transcript, and nothing else.
 *
 * Three facts: where the window is anchored, which blocks are open, and which
 * block is selected. All three are keyed by *block identity* rather than by
 * position, which is what makes them survive a stream that revises blocks in
 * place, a resize that re-wraps them, and an overlay that draws over the whole
 * region.
 *
 * Two things are deliberately not here.
 *
 * **No content.** Full content is obtained from the projection every time it is
 * drawn. The expansion set holds keys, never text — so a block that stops being
 * expandable, or whose content is revised, cannot be shown from a copy this
 * module kept.
 *
 * **No geometry.** Heights and row budgets belong to the component that
 * measures them, so this reducer stays a pure function of intent. The anchor
 * arithmetic that *does* need geometry lives in `./window.ts` and is called by
 * the caller, which is why every action here carries a resolved value rather
 * than a request to compute one.
 *
 * Nothing here is persisted. A scroll position is a property of a reading
 * session, and restoring one from a previous run would put a reader somewhere
 * they did not leave.
 */

import type { TranscriptBlock } from "../../presentation/index.ts";
import { blockKey } from "../../presentation/index.ts";
import { LATEST, type TranscriptAnchor } from "./window.ts";

export type TranscriptSurfaceState = {
  readonly anchor: TranscriptAnchor;
  /** Block keys the reader has opened. */
  readonly expanded: ReadonlySet<string>;
  /** The block commands act on, or `null` when the transcript is empty. */
  readonly selected: string | null;
};

export const INITIAL_TRANSCRIPT_STATE: TranscriptSurfaceState = {
  anchor: LATEST,
  expanded: new Set(),
  selected: null,
};

export type TranscriptSurfaceAction =
  /** A resolved anchor from `./window.ts`. */
  | { readonly kind: "anchor"; readonly anchor: TranscriptAnchor }
  | { readonly kind: "toggle-expansion"; readonly key: string }
  | { readonly kind: "select"; readonly key: string }
  /**
   * The projection changed.
   *
   * Carries the keys that still exist, so a selection or an expansion of a block
   * that is gone is dropped rather than kept as a key nothing resolves. A
   * rebuilt projection is the ordinary way that happens.
   */
  | { readonly kind: "reconcile"; readonly keys: readonly string[] };

export function transcriptSurfaceReducer(
  state: TranscriptSurfaceState,
  action: TranscriptSurfaceAction,
): TranscriptSurfaceState {
  switch (action.kind) {
    case "anchor":
      return { ...state, anchor: action.anchor };

    case "toggle-expansion": {
      const expanded = new Set(state.expanded);
      if (!expanded.delete(action.key)) {
        expanded.add(action.key);
      }
      // Opening a block selects it. The alternative is an expansion the reader
      // cannot collapse without first navigating back to it.
      return { ...state, expanded, selected: action.key };
    }

    case "select":
      return { ...state, selected: action.key };

    case "reconcile": {
      const present = new Set(action.keys);
      const expanded = new Set([...state.expanded].filter((key) => present.has(key)));
      const selected =
        state.selected !== null && present.has(state.selected)
          ? state.selected
          : (action.keys.at(-1) ?? null);
      // Identity when nothing changed. Reconciliation runs whenever the
      // projection's keys change, and a new state object for an unchanged answer
      // would re-render the tree from the effect that observed the render.
      if (selected === state.selected && expanded.size === state.expanded.size) {
        return state;
      }
      return { ...state, expanded, selected };
    }
  }
}

/** Every block key in the projection, in order. Used to reconcile and to move. */
export function keysOf(blocks: readonly TranscriptBlock[]): readonly string[] {
  return blocks.map((block) => blockKey(block.anchor));
}

/**
 * The key one step from the current selection.
 *
 * Clamped rather than wrapped. A transcript has a start and an end, and a
 * selection that jumped from the last block to the first would move a reader
 * across the whole history on a keypress meant to move them one row.
 */
export function neighbourKey(
  keys: readonly string[],
  selected: string | null,
  step: 1 | -1,
): string | null {
  if (keys.length === 0) {
    return null;
  }
  const index = selected === null ? -1 : keys.indexOf(selected);
  if (index === -1) {
    return (step === 1 ? keys.at(0) : keys.at(-1)) ?? null;
  }
  const next = Math.min(Math.max(index + step, 0), keys.length - 1);
  return keys[next] ?? null;
}
