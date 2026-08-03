/**
 * The resolved theme.
 *
 * What a component actually reads. The property worth holding is that resolution
 * *answers* — every token, every role, every symbol, at every combination — so a
 * view never has to handle a missing one, and the one deliberate `null` is the
 * absence of colour rather than the absence of an answer.
 */

import { describe, expect, test } from "bun:test";
import { COLOR_LEVELS, SYMBOL_SUPPORTS } from "../../domain/index.ts";
import { SYMBOL_ROLES } from "./symbols.ts";
import { resolveTheme, selectVariant } from "./theme.ts";
import {
  BORDER_STRENGTHS,
  COLOR_TOKENS,
  FULL_MOTION,
  MOTION_ROLES,
  NO_MOTION,
  SPACING,
  THEME_VARIANTS,
  TYPOGRAPHY_ROLES,
} from "./tokens.ts";

const BASE = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: false,
  generation: 1,
} as const;

describe("resolution", () => {
  test("answers for every role in every combination", () => {
    // The grid, again, and for the same reason as the palette's: a hole in it is
    // a component drawing with `undefined` on some specific terminal.
    for (const variant of THEME_VARIANTS) {
      for (const colorLevel of COLOR_LEVELS) {
        for (const symbols of SYMBOL_SUPPORTS) {
          const theme = resolveTheme({ ...BASE, variant, colorLevel, symbols });
          for (const token of COLOR_TOKENS) {
            const color = theme.color(token);
            expect({ token, missing: color === undefined }).toEqual({ token, missing: false });
          }
          for (const role of TYPOGRAPHY_ROLES) {
            expect(typeof theme.typography(role).bold).toBe("boolean");
          }
          for (const role of SYMBOL_ROLES) {
            expect({ role, drawn: theme.symbol(role).length > 0 }).toEqual({ role, drawn: true });
          }
          for (const strength of BORDER_STRENGTHS) {
            expect(() => theme.border(strength)).not.toThrow();
          }
        }
      }
    }
  });

  test("carries the generation it was built at", () => {
    // The only thing a cache compares.
    expect(resolveTheme({ ...BASE, generation: 9 }).generation).toBe(9);
  });

  test("has no colour at all when the terminal has none", () => {
    const theme = resolveTheme({ ...BASE, colorLevel: "none" });
    for (const token of COLOR_TOKENS) {
      expect({ token, color: theme.color(token) }).toEqual({ token, color: null });
    }
  });

  test("draws no border at the strength that means none", () => {
    // `none` is first in the vocabulary and is the default a region reaches for,
    // so it has to actually mean no line rather than the thinnest one.
    expect(resolveTheme(BASE).border("none")).toBe(null);
    expect(resolveTheme(BASE).border("focus")).not.toBe(null);
  });
});

describe("typography", () => {
  test("carries hierarchy in attributes, so it survives losing colour", () => {
    // A heading that was only accent-coloured would stop being a heading under
    // `NO_COLOR`, on exactly the terminals where structure matters most.
    const theme = resolveTheme({ ...BASE, colorLevel: "none" });
    expect(theme.typography("heading").bold).toBe(true);
    expect(theme.typography("body").bold).toBe(false);
    expect(theme.typography("link").underline).toBe(true);
  });

  test("stops rendering anything faintly in high contrast", () => {
    // Dim is the first thing someone selecting this variant is trying to escape.
    const theme = resolveTheme({ ...BASE, variant: "high-contrast" });
    expect(theme.typography("muted").dim).toBe(false);
    expect(theme.typography("label").dim).toBe(false);
    expect(resolveTheme(BASE).typography("muted").dim).toBe(true);
  });
});

describe("symbols and marks", () => {
  test("follow the domain's repertoire", () => {
    expect(resolveTheme({ ...BASE, symbols: "ascii" }).marks.truncation).toBe("...");
    expect(resolveTheme({ ...BASE, symbols: "unicode" }).marks.truncation).toBe("…");
  });

  test("narrow to the conservative set when asked, without dropping to ASCII", () => {
    // A multiplexer does not mean the terminal lacks Unicode. Falling all the
    // way to ASCII would throw away characters that work fine.
    const conservative = resolveTheme({ ...BASE, conservativeSymbols: true });
    expect(conservative.marks.truncation).toBe("…");
    expect(conservative.symbol("success")).not.toBe(resolveTheme(BASE).symbol("success"));
  });

  test("give the truncation mark a width the caller can plan around", () => {
    // The reason the mark is a theme value handed to `truncateToWidth` rather
    // than a constant in a component: ASCII's is three cells and Unicode's is
    // one, and a caller that assumed either would overflow on the other.
    expect(resolveTheme({ ...BASE, symbols: "ascii" }).marks.truncation.length).toBe(3);
    expect([...resolveTheme(BASE).marks.truncation].length).toBe(1);
  });
});

describe("motion", () => {
  test("maps every role to zero when reduced, rather than skipping the change", () => {
    // A mapping, not a branch. There must be no path where reduced motion
    // *omits* a state change instead of arriving at it immediately.
    const reduced = resolveTheme({ ...BASE, reducedMotion: true });
    for (const role of MOTION_ROLES) {
      expect({ role, duration: reduced.motion[role] }).toEqual({ role, duration: 0 });
    }
    expect(reduced.reducedMotion).toBe(true);
  });

  test("is short even when it is not reduced", () => {
    // Anything long enough to be noticed as an animation is long enough to be in
    // the way of someone reading.
    const theme = resolveTheme(BASE);
    for (const role of MOTION_ROLES) {
      expect({ role, short: theme.motion[role] <= 250 }).toEqual({ role, short: true });
    }
    expect(theme.motion).toEqual(FULL_MOTION);
    expect(NO_MOTION.reveal).toBe(0);
  });
});

describe("spacing", () => {
  test("resolves each step to a whole number of cells", () => {
    const theme = resolveTheme(BASE);
    for (const step of Object.keys(SPACING) as (keyof typeof SPACING)[]) {
      expect(Number.isInteger(theme.spacing(step))).toBe(true);
    }
    expect(theme.spacing("none")).toBe(0);
  });
});

describe("variant selection", () => {
  test("believes an explicit request over the terminal", () => {
    expect(selectVariant({ requested: "light", terminalPrefers: "dark" })).toBe("light");
    expect(selectVariant({ requested: "monochrome", terminalPrefers: "light" })).toBe("monochrome");
  });

  test("follows the terminal when nothing was requested", () => {
    expect(selectVariant({ requested: null, terminalPrefers: "light" })).toBe("light");
    expect(selectVariant({ requested: null, terminalPrefers: "dark" })).toBe("dark");
  });

  test("defaults to dark when the terminal never answered", () => {
    // A choice rather than a neutral default: an unanswered query most often
    // means an older or minimal terminal, and those are overwhelmingly dark.
    expect(selectVariant({ requested: null, terminalPrefers: null })).toBe("dark");
  });

  test("does not turn a colourless terminal into the monochrome variant", () => {
    // Different things. `none` means this terminal has no colour and the palette
    // already answers `null`; `monochrome` means someone wants an interface
    // designed without hue on a terminal that has it. Folding one into the other
    // would make the variant unreachable where it is useful.
    const colorless = resolveTheme({ ...BASE, colorLevel: "none" });
    expect(colorless.variant).toBe("dark");
  });
});
