/**
 * Whether a theme can be read, and whether it survives losing colour.
 *
 * The second is the one worth having. Colour-only meaning is easy to introduce,
 * invisible to whoever introduces it, and only discovered by the person running
 * in a terminal without colour — who has no way to know what they are missing.
 * These checks are the defence, and they are exhaustive over the statuses rather
 * than a spot check, because one status collapsing into another is exactly the
 * kind of thing a spot check misses.
 */

import { describe, expect, test } from "bun:test";
import { SYMBOL_SUPPORTS } from "../../domain/index.ts";
import {
  contrastFloorFor,
  contrastRatio,
  DE_EMPHASIZED_MINIMUM,
  distinguishableWithoutColor,
  HIGH_CONTRAST_MINIMUM,
  MINIMUM_CONTRAST,
  STATUS_PRESENTATION,
} from "./contrast.ts";
import { PALETTES } from "./palette.ts";
import { symbolsFor } from "./symbols.ts";
import { COLOR_TOKENS, STATUS_TOKENS, THEME_VARIANTS } from "./tokens.ts";

/** Tokens that are surfaces rather than things drawn on one. */
const SURFACES = new Set(["background", "elevatedSurface", "overlay", "selection"]);

describe("contrast", () => {
  test("computes the published ratio", () => {
    // Anchored against two values the standard's own examples fix, so a
    // rewritten implementation cannot drift while still looking plausible.
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#000000", "#000000")).toBeCloseTo(1, 5);
  });

  test("is symmetric", () => {
    // Which colour is the text and which is behind it does not change how far
    // apart they are.
    expect(contrastRatio("#7aa2f7", "#12141a")).toBeCloseTo(contrastRatio("#12141a", "#7aa2f7"), 5);
  });

  test("clears the floor for every drawn token in every variant", () => {
    for (const variant of THEME_VARIANTS) {
      const palette = PALETTES[variant];
      for (const token of COLOR_TOKENS) {
        if (SURFACES.has(token)) {
          continue;
        }
        const ratio = contrastRatio(palette[token], palette.background);
        expect({ variant, token, legible: ratio >= contrastFloorFor(variant, token) }).toEqual({
          variant,
          token,
          legible: true,
        });
      }
    }
  });

  test("clears it against the elevated surface too, not only the base", () => {
    // An overlay draws the same tokens on a different surface. A theme that only
    // held on the background would go faint exactly when a confirmation appeared.
    for (const variant of THEME_VARIANTS) {
      const palette = PALETTES[variant];
      for (const token of STATUS_TOKENS) {
        const ratio = contrastRatio(palette[token], palette.overlay);
        expect({ variant, token, legible: ratio >= MINIMUM_CONTRAST }).toEqual({
          variant,
          token,
          legible: true,
        });
      }
    }
  });

  test("holds high contrast to a higher floor than the others", () => {
    // Otherwise the variant is a name rather than a promise.
    expect(HIGH_CONTRAST_MINIMUM).toBeGreaterThan(MINIMUM_CONTRAST);
    expect(MINIMUM_CONTRAST).toBeGreaterThan(DE_EMPHASIZED_MINIMUM);
  });

  test("allows nothing to recede in high contrast", () => {
    // `ignored` is the one token permitted to be quiet, and it is not permitted
    // to be quiet here — which is the difference between a variant and a name.
    expect(contrastFloorFor("high-contrast", "ignored")).toBe(HIGH_CONTRAST_MINIMUM);
    expect(contrastFloorFor("dark", "ignored")).toBe(DE_EMPHASIZED_MINIMUM);
    expect(contrastFloorFor("dark", "error")).toBe(MINIMUM_CONTRAST);
  });
});

describe("without colour", () => {
  test("every status stays distinguishable in every repertoire", () => {
    // The monochrome guarantee. Two statuses may share a glyph — ASCII has fewer
    // characters than there are meanings — as long as they do not also share a
    // word, because the two channels together are what carries the distinction.
    for (const support of SYMBOL_SUPPORTS) {
      for (const conservative of [false, true]) {
        const symbols = symbolsFor(support, conservative);
        const collisions = distinguishableWithoutColor((status) => symbols[status]);
        expect({ support, conservative, collisions }).toEqual({
          support,
          conservative,
          collisions: [],
        });
      }
    }
  });

  test("survives every status collapsing onto one glyph", () => {
    // Not a hypothetical: ASCII has fewer characters than there are meanings, so
    // symbols alone were never going to carry this. The words are what make it
    // hold, which is why the next test guards them directly.
    expect(distinguishableWithoutColor(() => "?")).toEqual([]);
  });

  test("gives every status a word no other status uses", () => {
    // The mechanism the guarantee actually rests on, asserted where it lives
    // rather than inferred from the pair check above. A status added with a
    // duplicate word would pass every visual review and be invisible on a
    // monochrome terminal.
    const labels = STATUS_TOKENS.map((status) => STATUS_PRESENTATION[status].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("names a status that is not a shade of another", () => {
    // `uncertain` is the one this repository cannot afford to blur: the runtime
    // distinguishes a failure from an effect nobody observed, and a caller
    // reading one and acting on the other is the mistake the separate exit code
    // exists to prevent.
    expect(STATUS_PRESENTATION.uncertain.label).not.toBe(STATUS_PRESENTATION.error.label);
    expect(STATUS_PRESENTATION.cancelled.label).not.toBe(STATUS_PRESENTATION.error.label);
  });

  test("gives every status a word", () => {
    for (const status of STATUS_TOKENS) {
      expect({ status, label: STATUS_PRESENTATION[status].label }).toEqual({
        status,
        label: expect.stringMatching(/^[a-z]/),
      });
    }
  });
});
