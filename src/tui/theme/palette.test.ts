/**
 * The palettes and the rule that lowers them.
 *
 * The acceptance criterion this file owns is "every semantic token resolves at
 * true colour, 256, 16, and none" — and it is checked exhaustively rather than
 * by sampling, because the failure it guards against is one token being
 * forgotten, which sampling is exactly the wrong shape to catch.
 */

import { describe, expect, test } from "bun:test";
import { COLOR_LEVELS, type ColorLevel } from "../../domain/index.ts";
import { PALETTES, parseHex, quantize, resolvePalette } from "./palette.ts";
import { COLOR_TOKENS, THEME_VARIANTS } from "./tokens.ts";

describe("every variant", () => {
  test("defines every token, with no extras", () => {
    // A palette missing a token would resolve it to `undefined` and a component
    // would draw with no colour on a terminal that has one — silently, and only
    // for that token.
    for (const variant of THEME_VARIANTS) {
      expect(Object.keys(PALETTES[variant]).sort()).toEqual([...COLOR_TOKENS].sort());
    }
  });

  test("defines every token as a full six-digit hex", () => {
    // Three-digit hex and named colours would both parse somewhere and quantize
    // to black here, which is the worst possible failure mode: a colour that
    // looks deliberate.
    for (const variant of THEME_VARIANTS) {
      for (const token of COLOR_TOKENS) {
        expect({ variant, token, value: PALETTES[variant][token] }).toEqual({
          variant,
          token,
          value: expect.stringMatching(/^#[0-9a-f]{6}$/),
        });
      }
    }
  });
});

describe("resolution", () => {
  test("answers for every token at every colour depth", () => {
    // The acceptance criterion, exhaustively. Four depths times four variants
    // times every token — the whole grid, because the failure being guarded is
    // a hole in it.
    for (const variant of THEME_VARIANTS) {
      for (const level of COLOR_LEVELS) {
        const resolved = resolvePalette(variant, level);
        for (const token of COLOR_TOKENS) {
          const value = resolved[token];
          expect({ variant, level, token, resolved: value === undefined }).toEqual({
            variant,
            level,
            token,
            resolved: false,
          });
          if (level === "none") {
            expect({ variant, token, value }).toEqual({ variant, token, value: null });
          } else {
            expect({ variant, level, token, value }).toEqual({
              variant,
              level,
              token,
              value: expect.stringMatching(/^#[0-9a-f]{6}$/),
            });
          }
        }
      }
    }
  });

  test("returns no colour at all rather than a grey when there is none", () => {
    // The load-bearing return. A grey chosen here would let a component keep
    // drawing, and colour-only meaning would survive into the one terminal that
    // cannot carry it.
    expect(quantize("#ff0000", "none")).toBe(null);
  });

  test("leaves true colour exactly as authored", () => {
    for (const token of COLOR_TOKENS) {
      const authored = PALETTES.dark[token];
      expect(quantize(authored, "truecolor")).toBe(authored);
    }
  });
});

describe("lowering", () => {
  test("snaps to a colour the terminal already has", () => {
    // The reason Falryn quantizes rather than emitting full depth and letting
    // the terminal decide: terminals quantize differently, and a status that
    // survives on one and collapses on another is not a contract.
    const lowered = quantize("#7aa2f7", "ansi256");
    expect(lowered).toMatch(/^#[0-9a-f]{6}$/);
    // Idempotent: a palette entry lowered again is already an entry.
    expect(quantize(lowered ?? "", "ansi256")).toBe(lowered);
  });

  test("keeps a lowered colour near the one it came from", () => {
    // Nearest, not arbitrary. A bound rather than an exact value, because the
    // exact entry is the palette's business — what matters is that red stays
    // recognizably red.
    for (const level of ["ansi256", "basic"] satisfies ColorLevel[]) {
      for (const token of COLOR_TOKENS) {
        const authored = parseHex(PALETTES.dark[token]);
        const lowered = parseHex(quantize(PALETTES.dark[token], level) ?? "#000000");
        const drift = Math.sqrt(
          (authored.red - lowered.red) ** 2 +
            (authored.green - lowered.green) ** 2 +
            (authored.blue - lowered.blue) ** 2,
        );
        // 256 has an entry within a cube step; 16 is coarse and gets more room.
        expect({ level, token, near: drift <= (level === "ansi256" ? 24 : 160) }).toEqual({
          level,
          token,
          near: true,
        });
      }
    }
  });

  test("is deterministic", () => {
    // Written once and applied, rather than whatever the terminal happens to do.
    // Two runs over one colour must agree or nothing above can be golden-tested.
    for (const level of COLOR_LEVELS) {
      expect(quantize("#e0af68", level)).toBe(quantize("#e0af68", level));
    }
  });

  test("keeps pure black and white exactly at every depth", () => {
    // Both are members of every palette, so a nearest-match that moved them
    // would mean the search itself was wrong.
    for (const level of ["truecolor", "ansi256", "basic"] satisfies ColorLevel[]) {
      expect({ level, value: quantize("#000000", level) }).toEqual({ level, value: "#000000" });
      expect({ level, value: quantize("#ffffff", level) }).toEqual({ level, value: "#ffffff" });
    }
  });
});

describe("a malformed colour", () => {
  test("parses as black rather than throwing", () => {
    // Nothing in the tree should produce one — the shape test above is what
    // holds that — but parsing runs on every resolution and a throw there would
    // take down a frame over a typo in a constant.
    for (const malformed of ["", "#fff", "red", "#zzzzzz", "#1234567"]) {
      expect(parseHex(malformed)).toEqual({ red: 0, green: 0, blue: 0 });
    }
  });

  test("accepts a hex with or without the leading hash", () => {
    expect(parseHex("#7aa2f7")).toEqual(parseHex("7aa2f7"));
  });
});
