/**
 * Layout classes, chosen from measured cells.
 *
 * A pure function of two numbers, which is the whole design. The class governs
 * every arrangement decision in the interface, and it is decided in one place
 * from what the terminal actually reports — not from an assumed window, not from
 * a substituted default, and not independently by each region.
 *
 * The breakpoints are widths a person can actually work in rather than round
 * numbers. `standard` starts where a transcript and a composer both have room to
 * be read; `wide` starts where one contextual panel can be added without
 * squeezing the primary region below `standard`. A terminal below `compact` is
 * not given a smaller layout, because there is no honest arrangement at that
 * size — it is told so.
 *
 * This module imports no OpenTUI value and holds no state.
 */

import { MINIMUM_COLUMNS, MINIMUM_ROWS } from "./theme/index.ts";

export const LAYOUT_CLASSES = ["compact", "standard", "wide"] as const;

export type LayoutClass = (typeof LAYOUT_CLASSES)[number];

/**
 * Where `standard` begins.
 *
 * Below this a transcript and a contextual status cannot share a row without one
 * of them being truncated to uselessness, so secondary content becomes an
 * overlay or a route instead.
 */
export const STANDARD_COLUMNS = 72;

/**
 * Where `wide` begins.
 *
 * `STANDARD_COLUMNS` for the primary region, plus a panel narrow enough to be
 * worth having and wide enough to read. Derived rather than written as a
 * literal, so moving the first breakpoint moves this one with it instead of
 * silently overlapping.
 */
export const PANEL_COLUMNS = 32;
export const WIDE_COLUMNS = STANDARD_COLUMNS + PANEL_COLUMNS;

/**
 * Rows a layout needs before the class its width suggests is honest.
 *
 * Width alone is not enough: an 8-row terminal 200 columns wide has room for a
 * panel and nowhere to put it. A terminal short enough to fail this drops one
 * class rather than being refused, because the content is still reachable — it
 * is the *arrangement* that has to give.
 */
export const STANDARD_ROWS = 16;
export const WIDE_ROWS = 20;

export type Viewport = {
  /** Usable cells, as the renderer reports them. Never a substituted default. */
  readonly columns: number;
  readonly rows: number;
};

export type LayoutDecision =
  | { readonly kind: "layout"; readonly class: LayoutClass }
  /**
   * Too small for any arrangement to be honest.
   *
   * Carries what is needed rather than only that it is not met, so the message
   * a user sees can be actionable — "24×6" is a thing they can do something
   * about, "too small" is not.
   */
  | {
      readonly kind: "insufficient";
      readonly needColumns: number;
      readonly needRows: number;
    };

/**
 * The class for a viewport.
 *
 * Both dimensions are consulted for every class, and a terminal that meets a
 * width but not the matching height falls to the class below rather than to
 * `compact` — a 200×18 terminal is a good `standard` terminal and calling it
 * `compact` would throw away room it has.
 */
export function selectLayout(viewport: Viewport): LayoutDecision {
  const columns = usable(viewport.columns);
  const rows = usable(viewport.rows);

  if (columns < MINIMUM_COLUMNS || rows < MINIMUM_ROWS) {
    return { kind: "insufficient", needColumns: MINIMUM_COLUMNS, needRows: MINIMUM_ROWS };
  }
  if (columns >= WIDE_COLUMNS && rows >= WIDE_ROWS) {
    return { kind: "layout", class: "wide" };
  }
  if (columns >= STANDARD_COLUMNS && rows >= STANDARD_ROWS) {
    return { kind: "layout", class: "standard" };
  }
  return { kind: "layout", class: "compact" };
}

/**
 * A dimension the layout is willing to reason about.
 *
 * Zero, negative, fractional, and `NaN` all resolve to zero, which then fails
 * the minimum. This is not defensive noise: a terminal genuinely reports zero
 * during a resize, and a `NaN` reaching a comparison would make every one of
 * them false and silently select `compact` for a viewport that does not exist.
 */
function usable(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Whether this class shows one region at a time.
 *
 * The rule a narrow terminal must never break: layout may change, but the only
 * route to content may not be removed. In `compact` a secondary view becomes an
 * overlay or a route — it does not disappear.
 */
export function isSingleRegion(layoutClass: LayoutClass): boolean {
  return layoutClass === "compact";
}

/** Whether this class has room for one persistent contextual panel. */
export function hasContextPanel(layoutClass: LayoutClass): boolean {
  return layoutClass === "wide";
}

/**
 * Columns the primary region gets.
 *
 * The panel is subtracted rather than the primary region being given a
 * percentage, so widening the terminal widens the transcript and leaves the
 * panel at the size it needs. A permanently tiled control centre is what the
 * design direction refuses, and proportional splits are how interfaces arrive
 * at one.
 */
export function primaryColumns(viewport: Viewport, layoutClass: LayoutClass): number {
  const columns = usable(viewport.columns);
  return hasContextPanel(layoutClass)
    ? Math.max(STANDARD_COLUMNS, columns - PANEL_COLUMNS)
    : columns;
}

/**
 * Rows the header and the status line take before anything else is offered any.
 *
 * One each, and reserved rather than competed for. The status line is the row an
 * overlay may never cover, so the region that grows to hold content has to be
 * measured after both are taken — the alternative is a transcript that computes
 * its own window from the whole viewport and draws its last row over the one
 * place a terminal outcome arrives.
 */
export const HEADER_ROWS = 1;
export const STATUS_ROWS = 1;

/**
 * Rows the primary region gets.
 *
 * The counterpart to {@link primaryColumns}, and subtractive for the same
 * reason: the chrome asks for what it needs and the primary region receives
 * what is left, never a proportion of the window.
 */
export function primaryRows(viewport: Viewport): number {
  return Math.max(0, usable(viewport.rows) - HEADER_ROWS - STATUS_ROWS);
}

/**
 * Shares a row out among fields that each want a width.
 *
 * The obvious division — an even share, or a fixed weight each — is wrong for
 * the same reason in both forms: it truncates a field that needs the room while
 * leaving room a short field will not use. A workspace path beside a two-letter
 * branch name is the everyday case, and an even quarter each cuts the path while
 * the branch column sits half empty.
 *
 * So the rule is: anything that fits gets exactly what it asked for, and only
 * the fields that do not fit share what is left, by weight. Repeated until
 * nothing new fits, because freeing a short field's surplus can be what makes
 * the next one fit.
 *
 * Pure, so the whole behavior is testable without measuring a single glyph.
 */
export function shareRow(
  fields: readonly { readonly natural: number; readonly weight: number }[],
  room: number,
  minimum = 1,
): readonly number[] {
  const granted: number[] = fields.map(() => 0);
  const pending = new Set(fields.keys());
  let left = Math.max(0, room);

  let settled = false;
  while (!settled && pending.size > 0) {
    settled = true;
    const weight = [...pending].reduce((total, index) => total + (fields[index]?.weight ?? 0), 0);
    if (weight <= 0) {
      break;
    }
    for (const index of [...pending]) {
      const field = fields[index];
      if (field === undefined) {
        continue;
      }
      const share = Math.floor((left * field.weight) / weight);
      if (field.natural <= share) {
        granted[index] = field.natural;
        left -= field.natural;
        pending.delete(index);
        settled = false;
      }
    }
  }

  if (pending.size > 0) {
    const weight = [...pending].reduce((total, index) => total + (fields[index]?.weight ?? 0), 0);
    for (const index of pending) {
      const field = fields[index];
      granted[index] =
        weight <= 0
          ? minimum
          : Math.max(minimum, Math.floor((left * (field?.weight ?? 0)) / weight));
    }
  }
  return granted;
}
