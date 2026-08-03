/**
 * Focus, as a logical path.
 *
 * Not a pointer to a component. A pointer is invalidated by every re-render, so
 * a focus model built on one has to be rebuilt whenever the tree changes —
 * which is exactly when focus most needs to survive. A path is a name, and a
 * name outlives the thing it named: after a resize, an overlay opening, or an
 * item being removed, the question "where was focus" still has an answer.
 *
 * The model is a value. Every operation returns a new one, so focus is
 * reproducible from a sequence of events rather than accumulated in a mutable
 * object — which is what lets the round-trip properties below be tested without
 * a renderer.
 *
 * This module imports no OpenTUI value and no React.
 */

/** A focusable region: a stable id and the words that name it out loud. */
export type FocusRegion = {
  readonly id: string;
  /**
   * What this region is, in words.
   *
   * Required rather than optional. A region with no label is one a user cannot
   * be told they are in, and "the focus indicator is not colour-only" is only
   * achievable if there is something to say.
   */
  readonly label: string;
};

export type FocusModel = {
  /** Reachable regions, in semantic reading order. Tab order follows this. */
  readonly order: readonly FocusRegion[];
  /** The focused region's id, or `null` when nothing is reachable. */
  readonly focused: string | null;
  /**
   * Where focus was before the current containment began.
   *
   * A stack rather than a single value, because an overlay opening over an
   * overlay is a thing that happens and a single slot would lose the outer one.
   */
  readonly restore: readonly string[];
};

export function createFocusModel(order: readonly FocusRegion[]): FocusModel {
  return { order, focused: order[0]?.id ?? null, restore: [] };
}

export const EMPTY_FOCUS: FocusModel = { order: [], focused: null, restore: [] };

function indexOf(model: FocusModel, id: string | null): number {
  return id === null ? -1 : model.order.findIndex((region) => region.id === id);
}

/**
 * The next region in reading order, wrapping.
 *
 * Wrapping rather than stopping at the end: a terminal interface has no scroll
 * bar to show you have reached the last region, so stopping reads as the key
 * having failed. Wrapping is discoverable — one more press returns you.
 */
export function focusNext(model: FocusModel): FocusModel {
  return moveBy(model, 1);
}

export function focusPrevious(model: FocusModel): FocusModel {
  return moveBy(model, -1);
}

function moveBy(model: FocusModel, step: number): FocusModel {
  if (model.order.length === 0) {
    return { ...model, focused: null };
  }
  const current = indexOf(model, model.focused);
  // A model whose focus is not in its own order — after a removal, say — moves
  // to the first region rather than nowhere.
  const from = current === -1 ? (step > 0 ? -1 : 0) : current;
  const next = (from + step + model.order.length) % model.order.length;
  return { ...model, focused: model.order[next]?.id ?? null };
}

/** Focuses a region by id, or leaves the model alone when it is not reachable. */
export function focusRegion(model: FocusModel, id: string): FocusModel {
  return indexOf(model, id) === -1 ? model : { ...model, focused: id };
}

/**
 * Contains focus within a new set of regions, remembering where it was.
 *
 * What opening a modal overlay does. The regions behind it stop being reachable
 * — not merely visually behind, but out of tab order entirely, which is what
 * "background regions do not consume keys meant for the focused control" means
 * when a user presses Tab.
 */
export function containFocus(model: FocusModel, regions: readonly FocusRegion[]): FocusModel {
  return {
    order: regions,
    focused: regions[0]?.id ?? null,
    restore: model.focused === null ? model.restore : [...model.restore, model.focused],
  };
}

/**
 * Releases containment and returns focus to the closest surviving region.
 *
 * "Closest surviving" is the load-bearing phrase. The region focus came from may
 * be gone — the overlay was open while a resize removed a panel — so the
 * remembered id is a preference rather than a guarantee, and the fallback is the
 * first reachable region rather than nothing.
 */
export function releaseFocus(model: FocusModel, regions: readonly FocusRegion[]): FocusModel {
  const remembered = model.restore.at(-1) ?? null;
  const restore = model.restore.slice(0, -1);
  const survived = regions.some((region) => region.id === remembered);
  return {
    order: regions,
    focused: survived && remembered !== null ? remembered : (regions[0]?.id ?? null),
    restore,
  };
}

/**
 * The model over a new set of regions, keeping focus where it can.
 *
 * What a resize does, and what removing an item does. Focus stays put when its
 * region survived. When it did not, the *documented neighbour* is the region
 * that now occupies the same position in reading order — the one that visually
 * took its place — falling back to the last region when the removed one was at
 * the end. Choosing "the first region" instead would send someone back to the
 * top of the interface every time something below them disappeared.
 */
export function withRegions(model: FocusModel, regions: readonly FocusRegion[]): FocusModel {
  if (regions.length === 0) {
    return { ...model, order: regions, focused: null };
  }
  if (regions.some((region) => region.id === model.focused)) {
    return { ...model, order: regions };
  }

  const previousIndex = indexOf(model, model.focused);
  const neighbour = previousIndex === -1 ? 0 : Math.min(previousIndex, regions.length - 1);
  return { ...model, order: regions, focused: regions[neighbour]?.id ?? null };
}

/** The focused region, or `null`. */
export function focusedRegion(model: FocusModel): FocusRegion | null {
  return model.order.find((region) => region.id === model.focused) ?? null;
}

/** Whether focus is currently contained, so a caller knows a release is pending. */
export function isContained(model: FocusModel): boolean {
  return model.restore.length > 0;
}
