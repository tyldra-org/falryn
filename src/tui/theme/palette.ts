/**
 * The palettes, and the one rule that lowers them.
 *
 * Two things live here and are deliberately not separable. The four variants are
 * authored at full colour depth, and *every* lower depth is derived from them by
 * a written rule rather than authored again. A second hand-written 256-colour
 * palette would be a second set of decisions that drifts from the first the day
 * someone adjusts one warning colour and not the other — and the drift would be
 * invisible to everyone whose terminal reports true colour.
 *
 * The rule is: snap to the nearest colour the terminal actually has. That is
 * done here, in Falryn, rather than left to the terminal, because terminals
 * quantize differently and a status that stays distinguishable on one and
 * collapses into its neighbour on another is not a contract. Snapping to a
 * palette entry means the bytes we emit name a colour the terminal already has,
 * so there is nothing left for it to reinterpret.
 *
 * At `none` there is no colour at all — the resolution returns `null` rather
 * than grey, so a component cannot accidentally keep drawing a monochrome
 * terminal in shades. Meaning at that depth is carried by symbols, attributes,
 * and words, which `contrast.ts` and its tests hold to.
 */

import type { ColorLevel } from "../../domain/index.ts";
import type { ColorToken, Palette, ThemeVariant } from "./tokens.ts";

/**
 * Dark, the default.
 *
 * One accent plus semantic status colours, which is the design direction's
 * rule: no rainbow categorization and no large decorative colour fields. The
 * Git states reuse the status hues deliberately — added reads as success and
 * removed as error, because that is what they mean.
 */
const DARK: Palette = {
  foreground: "#d6d9de",
  mutedForeground: "#8b9198",
  background: "#12141a",
  elevatedSurface: "#1b1e26",
  overlay: "#232732",

  accent: "#7aa2f7",
  focus: "#9ece6a",
  selection: "#2d3346",
  link: "#7dcfff",

  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
  informational: "#7dcfff",
  pending: "#8b9198",
  cancelled: "#a89bb5",
  // Deliberately not a shade of error. An effect nobody observed is a different
  // fact from a failure, and rendering them alike would erase the distinction
  // the exit table exists to carry.
  uncertain: "#d4a5e8",

  added: "#9ece6a",
  removed: "#f7768e",
  modified: "#e0af68",
  conflict: "#ff9e64",
  ignored: "#5c6370",
  untracked: "#7dcfff",
};

const LIGHT: Palette = {
  foreground: "#22262d",
  mutedForeground: "#5f666f",
  background: "#fbfbfd",
  elevatedSurface: "#f1f2f6",
  overlay: "#e6e8ef",

  accent: "#2f5fd0",
  focus: "#2f7a2f",
  selection: "#d8e0f5",
  link: "#0f6f9e",

  success: "#2f7a2f",
  warning: "#8a5a00",
  error: "#b3202f",
  informational: "#0f6f9e",
  pending: "#5f666f",
  cancelled: "#6d5b7c",
  uncertain: "#7a3f9e",

  added: "#2f7a2f",
  removed: "#b3202f",
  modified: "#8a5a00",
  conflict: "#a34a00",
  ignored: "#8b9198",
  untracked: "#0f6f9e",
};

/**
 * High contrast: the same meanings, pushed apart.
 *
 * Not "dark with brighter colours". Every foreground here is chosen against the
 * background for ratio first and hue second, which is why several statuses are
 * nearer to pure than they are in `DARK` — and why `contrast.ts` holds this
 * variant to a higher floor than the others.
 */
const HIGH_CONTRAST: Palette = {
  foreground: "#ffffff",
  mutedForeground: "#c8c8c8",
  background: "#000000",
  elevatedSurface: "#101010",
  overlay: "#1a1a1a",

  accent: "#61b0ff",
  focus: "#00ff66",
  selection: "#003b6b",
  link: "#5fd7ff",

  success: "#00ff66",
  warning: "#ffcc00",
  error: "#ff5f5f",
  informational: "#5fd7ff",
  pending: "#c8c8c8",
  cancelled: "#d7a3ff",
  uncertain: "#ff87ff",

  added: "#00ff66",
  removed: "#ff5f5f",
  modified: "#ffcc00",
  conflict: "#ff8700",
  // Lighter than the other variants' `ignored`. High contrast has no
  // de-emphasized tokens: someone selected it because faint text was the
  // problem, so even "this is ignored" has to clear the variant's own floor.
  ignored: "#a8a8a8",
  untracked: "#5fd7ff",
};

/**
 * Monochrome: no hue at all, only the surfaces.
 *
 * A variant rather than a colour level. Someone can ask for it on a true-colour
 * terminal — reading a transcript in a screenshot, a colour-blind palette that
 * helps nobody, a terminal whose theme fights ours — and get an interface that
 * was designed to work without hue rather than one with the hue removed. Every
 * status resolves to the plain foreground here, so the symbols and words are
 * doing all of the work, which is exactly the condition the monochrome test
 * checks.
 */
const MONOCHROME: Palette = {
  foreground: "#e6e6e6",
  mutedForeground: "#9a9a9a",
  background: "#000000",
  elevatedSurface: "#141414",
  overlay: "#1e1e1e",

  accent: "#e6e6e6",
  focus: "#ffffff",
  selection: "#333333",
  link: "#e6e6e6",

  success: "#e6e6e6",
  warning: "#e6e6e6",
  error: "#ffffff",
  informational: "#e6e6e6",
  pending: "#9a9a9a",
  cancelled: "#9a9a9a",
  uncertain: "#ffffff",

  added: "#e6e6e6",
  removed: "#ffffff",
  modified: "#e6e6e6",
  conflict: "#ffffff",
  ignored: "#9a9a9a",
  untracked: "#e6e6e6",
};

export const PALETTES: Readonly<Record<ThemeVariant, Palette>> = {
  dark: DARK,
  light: LIGHT,
  monochrome: MONOCHROME,
  "high-contrast": HIGH_CONTRAST,
};

/* -------------------------------------------------------------------------- */
/* Colour arithmetic                                                           */
/* -------------------------------------------------------------------------- */

export type Rgb = { readonly red: number; readonly green: number; readonly blue: number };

/** A `#rrggbb` string as channels. Malformed input is black rather than a throw. */
export function parseHex(hex: string): Rgb {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (value.length !== 6) {
    return { red: 0, green: 0, blue: 0 };
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isInteger(parsed)) {
    return { red: 0, green: 0, blue: 0 };
  }
  return {
    // eslint-disable-next-line no-bitwise -- channel extraction is what hex is
    red: (parsed >> 16) & 0xff,
    green: (parsed >> 8) & 0xff,
    blue: parsed & 0xff,
  };
}

function toHex(color: Rgb): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

/** Squared distance. Squared because only the ordering matters and roots cost. */
function distance(left: Rgb, right: Rgb): number {
  const red = left.red - right.red;
  const green = left.green - right.green;
  const blue = left.blue - right.blue;
  return red * red + green * green + blue * blue;
}

/** The sixteen colours every colour terminal has, in the conventional order. */
const BASIC_16: readonly string[] = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];

/** The levels the xterm 6×6×6 cube uses. Not evenly spaced, and that matters. */
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/**
 * The 256-colour palette, built rather than listed.
 *
 * Sixteen base colours, a 6×6×6 cube, and twenty-four greys — the definition of
 * the palette, not a transcription of it. A transcribed table is 256 chances to
 * make a typo that shows up as one status being slightly wrong on one class of
 * terminal.
 */
const ANSI_256: readonly Rgb[] = (() => {
  const entries: Rgb[] = BASIC_16.map(parseHex);
  for (const red of CUBE_LEVELS) {
    for (const green of CUBE_LEVELS) {
      for (const blue of CUBE_LEVELS) {
        entries.push({ red, green, blue });
      }
    }
  }
  for (let step = 0; step < 24; step += 1) {
    const level = 8 + step * 10;
    entries.push({ red: level, green: level, blue: level });
  }
  return entries;
})();

const BASIC_16_RGB: readonly Rgb[] = BASIC_16.map(parseHex);

function nearest(color: Rgb, candidates: readonly Rgb[]): Rgb {
  let best = candidates[0] ?? { red: 0, green: 0, blue: 0 };
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const measured = distance(color, candidate);
    if (measured < bestDistance) {
      bestDistance = measured;
      best = candidate;
    }
  }
  return best;
}

/**
 * A colour lowered to what this terminal has.
 *
 * `null` at `none`, and that is the load-bearing return: a component handed
 * `null` emits no colour at all rather than a grey that would let colour-only
 * meaning survive into a monochrome terminal looking almost right.
 */
export function quantize(hex: string, level: ColorLevel): string | null {
  switch (level) {
    case "none":
      return null;
    case "truecolor":
      return hex;
    case "ansi256":
      return toHex(nearest(parseHex(hex), ANSI_256));
    case "basic":
      return toHex(nearest(parseHex(hex), BASIC_16_RGB));
  }
}

/** Every token of a variant, lowered to one colour depth. */
export function resolvePalette(
  variant: ThemeVariant,
  level: ColorLevel,
): Readonly<Record<ColorToken, string | null>> {
  const source = PALETTES[variant];
  const resolved: Partial<Record<ColorToken, string | null>> = {};
  for (const token of Object.keys(source) as ColorToken[]) {
    resolved[token] = quantize(source[token], level);
  }
  return resolved as Readonly<Record<ColorToken, string | null>>;
}
