/**
 * Whether a theme can actually be read.
 *
 * Two checks, and they answer different questions. Contrast asks whether text
 * is legible against the surface behind it. Distinguishability asks whether two
 * *different* meanings can be told apart — and asks it in the condition where
 * colour is gone, because that is the condition a theme is most likely to fail
 * and least likely to be tested in by the person who wrote it.
 *
 * Both are pure functions over a palette rather than assertions inside one, so
 * the tests own the thresholds and a variant that drifts below one fails a check
 * instead of shipping. Nothing here runs at startup: a contrast ratio computed
 * on every launch would be work done to confirm a constant.
 */

import { parseHex, type Rgb } from "./palette.ts";
import type { StatusToken } from "./tokens.ts";

/**
 * WCAG relative luminance.
 *
 * Terminals are not browsers and the standard was not written for them, but the
 * question it answers — how bright does this appear to a human eye — is the same
 * question, and a published formula that has been argued over for two decades is
 * a better answer than one invented here.
 */
function relativeLuminance(color: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);
}

/** The WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(parseHex(foreground));
  const second = relativeLuminance(parseHex(background));
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The floor ordinary text must clear.
 *
 * Below WCAG AA's 4.5, deliberately. A terminal is not a web page: the user
 * chose the font and its size, the background is a flat colour rather than an
 * image, and a threshold strict enough to reject every muted foreground would
 * push the design toward the uniform high-contrast wall the muted role exists
 * to avoid. 4.0 keeps genuinely unreadable pairings out while leaving the
 * hierarchy the design direction asks for.
 */
export const MINIMUM_CONTRAST = 4.0;

/** What the high-contrast variant must clear. AA for ordinary text, and then some. */
export const HIGH_CONTRAST_MINIMUM = 7.0;

/**
 * The floor for a token whose job is to recede.
 *
 * WCAG's threshold for large text and non-text elements. Exactly one token uses
 * it: `ignored`, which marks a file Git was told to ignore. Rendering that at
 * the same weight as a modified file would defeat the only thing it
 * communicates. It is still a floor rather than an exemption — below this the
 * text stops being readable at all, which is a different thing from being quiet.
 */
export const DE_EMPHASIZED_MINIMUM = 3.0;

/** Tokens held to the de-emphasized floor. Deliberately a very short list. */
const DE_EMPHASIZED: ReadonlySet<string> = new Set(["ignored"]);

/**
 * The ratio a token must clear in a variant.
 *
 * High contrast has no de-emphasized tokens, and that is the variant's whole
 * promise: someone who selected it did so because faint text was the problem, so
 * "deliberately quiet" is not a defence there.
 */
export function contrastFloorFor(variant: string, token: string): number {
  if (variant === "high-contrast") {
    return HIGH_CONTRAST_MINIMUM;
  }
  return DE_EMPHASIZED.has(token) ? DE_EMPHASIZED_MINIMUM : MINIMUM_CONTRAST;
}

/**
 * How a status is presented, beyond its colour.
 *
 * The reason this table exists at all: colour is one of three channels a status
 * has, and it is the one most likely to be missing. The symbol role and the word
 * are the other two, and they are declared beside the token so
 * {@link distinguishableWithoutColor} can check that they are enough on their
 * own — which is the monochrome guarantee, made structural instead of reviewed.
 */
export type StatusPresentation = {
  readonly token: StatusToken;
  readonly symbol: StatusToken;
  /** The word. Sentence case, because it appears mid-sentence as often as not. */
  readonly label: string;
};

export const STATUS_PRESENTATION: Readonly<Record<StatusToken, StatusPresentation>> = {
  success: { token: "success", symbol: "success", label: "succeeded" },
  warning: { token: "warning", symbol: "warning", label: "warning" },
  error: { token: "error", symbol: "error", label: "failed" },
  informational: { token: "informational", symbol: "informational", label: "note" },
  pending: { token: "pending", symbol: "pending", label: "working" },
  cancelled: { token: "cancelled", symbol: "cancelled", label: "cancelled" },
  // Never "failed". The runtime distinguishes a failure from an effect nobody
  // observed, and a caller reading one and acting on the other is the exact
  // mistake the separate exit code exists to prevent.
  uncertain: { token: "uncertain", symbol: "uncertain", label: "unconfirmed" },
};

/**
 * Whether every status stays distinct once colour is gone.
 *
 * Takes the resolved symbols, because the answer depends on the repertoire: two
 * statuses can have different glyphs in Unicode and collapse onto the same
 * ASCII character. A pair that shares a symbol is fine as long as it does not
 * also share a word — the two channels together are the guarantee, not either
 * one alone.
 *
 * Returns the colliding pairs rather than a boolean, so a failing check names
 * what collided instead of only that something did.
 */
export function distinguishableWithoutColor(
  symbolFor: (status: StatusToken) => string,
): readonly (readonly [StatusToken, StatusToken])[] {
  const statuses = Object.keys(STATUS_PRESENTATION) as StatusToken[];
  const collisions: (readonly [StatusToken, StatusToken])[] = [];

  for (let first = 0; first < statuses.length; first += 1) {
    for (let second = first + 1; second < statuses.length; second += 1) {
      const left = statuses[first];
      const right = statuses[second];
      if (left === undefined || right === undefined) {
        continue;
      }
      const sameSymbol = symbolFor(left) === symbolFor(right);
      const sameLabel = STATUS_PRESENTATION[left].label === STATUS_PRESENTATION[right].label;
      if (sameSymbol && sameLabel) {
        collisions.push([left, right]);
      }
    }
  }
  return collisions;
}
