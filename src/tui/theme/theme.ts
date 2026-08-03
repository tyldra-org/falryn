/**
 * The resolved theme: one value a component can read without asking anything.
 *
 * Resolution happens once, at the top, and produces concrete answers — this
 * colour or none, this glyph, this many milliseconds. A component never sees a
 * colour level, a symbol repertoire, or a reduced-motion flag, which is what
 * keeps capability handling from spreading into every view. It also means the
 * whole surface a view depends on is one object with a generation on it, so a
 * cache can be invalidated by comparing a number.
 *
 * A resolved colour may be `null`, and callers must pass it through rather than
 * substitute a default. `null` is the terminal saying it has no colour, and a
 * grey chosen here to fill the hole would let colour-only meaning survive into
 * exactly the terminal that cannot carry it.
 */

import type { ColorLevel, SymbolSupport } from "../../domain/index.ts";
import { resolvePalette } from "./palette.ts";
import { type SymbolRole, type SymbolSet, symbolsFor } from "./symbols.ts";
import {
  type BorderStrength,
  type ColorToken,
  FULL_MOTION,
  type Marks,
  type Motion,
  NO_MOTION,
  SPACING,
  type SpacingStep,
  type ThemeVariant,
  type Typography,
  type TypographyRole,
  type TypographyStyle,
} from "./tokens.ts";

/**
 * The typography roles, shared by every variant except high contrast.
 *
 * Attributes rather than colours, and the split matters: an attribute survives
 * `NO_COLOR`, so a heading stays a heading on a terminal with no palette at all.
 * That is why `heading` is bold rather than accent-coloured.
 */
const STANDARD_TYPOGRAPHY: Typography = {
  body: { bold: false, dim: false, italic: false, underline: false },
  heading: { bold: true, dim: false, italic: false, underline: false },
  label: { bold: false, dim: true, italic: false, underline: false },
  emphasis: { bold: true, dim: false, italic: false, underline: false },
  muted: { bold: false, dim: true, italic: false, underline: false },
  // Not italic: a terminal that lacks italics renders them as inverse on some
  // emulators, and inverse code inside a paragraph is worse than plain code.
  code: { bold: false, dim: false, italic: false, underline: false },
  link: { bold: false, dim: false, italic: false, underline: true },
};

/**
 * High contrast adds a second channel everywhere it can.
 *
 * `label` and `muted` stop being dim, because dim is the first thing a
 * high-contrast user is trying to get away from — the whole point of the variant
 * is that nothing important is rendered faintly.
 */
const HIGH_CONTRAST_TYPOGRAPHY: Typography = {
  ...STANDARD_TYPOGRAPHY,
  label: { bold: true, dim: false, italic: false, underline: false },
  muted: { bold: false, dim: false, italic: false, underline: false },
  heading: { bold: true, dim: false, italic: false, underline: true },
};

/** The line style each border strength draws, or `null` for no border at all. */
const BORDER_STYLES: Readonly<Record<BorderStrength, "single" | "rounded" | "heavy" | null>> = {
  none: null,
  subtle: "rounded",
  strong: "single",
  focus: "heavy",
};

export type Theme = {
  readonly variant: ThemeVariant;
  readonly colorLevel: ColorLevel;
  /**
   * Increments whenever any resolved value could have changed.
   *
   * The only thing a cache needs to compare. A component holding wrapped text
   * from generation 3 knows it is stale at generation 4 without diffing a
   * palette, and a stale frame cannot be mistaken for a current one.
   */
  readonly generation: number;
  /** A resolved colour, or `null` when this terminal has none. Never substituted. */
  color(token: ColorToken): string | null;
  typography(role: TypographyRole): TypographyStyle;
  symbol(role: SymbolRole): string;
  readonly symbols: SymbolSet;
  border(strength: BorderStrength): "single" | "rounded" | "heavy" | null;
  spacing(step: SpacingStep): number;
  readonly motion: Motion;
  /** Whether motion was reduced. Carried so a view can say so, not so it can branch. */
  readonly reducedMotion: boolean;
  readonly marks: Marks;
};

export type ThemeRequest = {
  readonly variant: ThemeVariant;
  /**
   * The *resolved* colour level, after `--color` and `NO_COLOR`.
   *
   * Not the raw capability. The command surface's `--color` overrides the
   * derived fact, and a theme built from the underived one would put colour on a
   * handle the user refused it for.
   */
  readonly colorLevel: ColorLevel;
  readonly symbols: SymbolSupport;
  /** Selects the narrower Unicode set: a multiplexer or a remote session. */
  readonly conservativeSymbols?: boolean;
  readonly reducedMotion: boolean;
  readonly generation: number;
};

export function resolveTheme(request: ThemeRequest): Theme {
  const palette = resolvePalette(request.variant, request.colorLevel);
  const symbols = symbolsFor(request.symbols, request.conservativeSymbols ?? false);
  const typography =
    request.variant === "high-contrast" ? HIGH_CONTRAST_TYPOGRAPHY : STANDARD_TYPOGRAPHY;
  const motion = request.reducedMotion ? NO_MOTION : FULL_MOTION;

  return {
    variant: request.variant,
    colorLevel: request.colorLevel,
    generation: request.generation,
    color: (token) => palette[token],
    typography: (role) => typography[role],
    symbol: (role) => symbols[role],
    symbols,
    border: (strength) => BORDER_STYLES[strength],
    spacing: (step) => SPACING[step],
    motion,
    reducedMotion: request.reducedMotion,
    marks: {
      truncation: symbols.truncation,
      separator: symbols.separator,
      bullet: symbols.bullet,
    },
  };
}

/**
 * The variant a run should use.
 *
 * An explicit request wins. Otherwise the terminal's own light/dark preference
 * decides, and a terminal that never answered gets dark — which is a choice
 * rather than a neutral default, made because an unanswered query most often
 * means an older or minimal terminal, and those are overwhelmingly dark.
 *
 * A colour level of `none` does **not** select the monochrome variant. They are
 * different things: `none` means this terminal has no colour, and the palette
 * resolution already answers `null` for every token. `monochrome` means someone
 * wants an interface designed without hue *on a terminal that has it*. Folding
 * one into the other would make the variant unreachable where it is useful.
 */
export function selectVariant(request: {
  readonly requested: ThemeVariant | null;
  readonly terminalPrefers: "light" | "dark" | null;
}): ThemeVariant {
  if (request.requested !== null) {
    return request.requested;
  }
  return request.terminalPrefers === "light" ? "light" : "dark";
}
