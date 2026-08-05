/**
 * The composer-owned repeated-press policy.
 *
 * OpenTUI owns pointer placement, selection, dragging, scrolling, and every
 * word or line boundary. Falryn keeps only the bounded timing and same-cell
 * rule OpenTUI's mouse event cannot provide: its events carry neither a press
 * count nor a timestamp.
 */

import { duration, type Instant } from "../../domain/index.ts";

/** A second press exactly this long after the first still continues the sequence. */
export const REPEATED_PRESS_WINDOW = duration(400);

export type RepeatedPressCount = 1 | 2 | 3;

/** A terminal cell after the renderer has quantized the pointer position. */
export type TerminalCell = {
  readonly x: number;
  readonly y: number;
};

/** The last qualifying primary press, stored without retaining a renderer event. */
export type ClickSequence = {
  readonly cell: TerminalCell;
  readonly at: Instant;
  readonly count: RepeatedPressCount;
};

export type ClickSequenceInput =
  | {
      readonly kind: "press";
      readonly button: "primary" | "other";
      readonly cell: TerminalCell;
    }
  | { readonly kind: "drag" };

export type ClickSequenceTransition = {
  readonly sequence: ClickSequence | null;
  /** `null` means the input reset the sequence and selects nothing. */
  readonly count: RepeatedPressCount | null;
};

/**
 * Advances the bounded repeated-press sequence.
 *
 * A drag or a non-primary press deliberately clears the last qualifying press:
 * neither can begin a word or line selection. A backward clock is likewise a
 * new sequence, because elapsed time is not trustworthy across that boundary.
 */
export function transitionClickSequence(
  previous: ClickSequence | null,
  input: ClickSequenceInput,
  now: Instant,
): ClickSequenceTransition {
  if (input.kind === "drag" || input.button === "other") {
    return { sequence: null, count: null };
  }

  const count = continues(previous, input.cell, now) ? nextCount(previous.count) : 1;
  return {
    count,
    sequence: { cell: { ...input.cell }, at: now, count },
  };
}

function continues(
  previous: ClickSequence | null,
  cell: TerminalCell,
  now: Instant,
): previous is ClickSequence {
  return (
    previous !== null &&
    now >= previous.at &&
    now - previous.at <= REPEATED_PRESS_WINDOW &&
    previous.cell.x === cell.x &&
    previous.cell.y === cell.y
  );
}

function nextCount(count: RepeatedPressCount): RepeatedPressCount {
  switch (count) {
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 1;
  }
}
