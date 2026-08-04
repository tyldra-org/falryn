/**
 * The display-text primitives.
 *
 * The properties worth protecting here are the ones a renderer silently relies
 * on: that width is display width rather than length, that a wrap over a
 * hostile width terminates, and that nothing a value contains can reach the
 * terminal as control.
 */

import { describe, expect, test } from "bun:test";

import {
  displayWidth,
  graphemes,
  MAX_DISPLAY_WIDTH,
  sanitizeTerminalText,
  truncateToWidth,
  wrapToWidth,
} from "./text-display.ts";

/**
 * Whether any character here could reach the terminal as control.
 *
 * A scan rather than a pattern: a regular expression naming a control
 * character is itself the thing the linter refuses, and rightly.
 */
function holdsControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

describe("graphemes", () => {
  test("counts what a person would call a character", () => {
    // The three shapes that break a code-point cursor: a combining mark, a
    // regional-indicator pair, and a zero-width-joiner sequence. Each is one
    // character to the person typing it and more than one code point to the
    // machine, and a cursor that moved by the second lands inside a character.
    expect(graphemes("e\u0301").length).toBe(1);
    expect(graphemes("\u{1F1EF}\u{1F1F5}").length).toBe(1);
    expect(graphemes("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}").length).toBe(1);
  });

  test("round-trips by joining", () => {
    // The property the editing model relies on: text rebuilt from its graphemes
    // is the same text, so an index into them can never name a position that is
    // not a character boundary.
    for (const text of ["", "plain", "e\u0301clair", "\u65E5\u672C\u8A9E", "a\nb"]) {
      expect(graphemes(text).join("")).toBe(text);
    }
  });

  test("treats a newline as its own character", () => {
    // Which is what makes the editor's line arithmetic a walk over graphemes
    // rather than a second split of the string.
    expect(graphemes("a\nb")).toEqual(["a", "\n", "b"]);
  });
});

describe("display width", () => {
  test("counts ASCII by character", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("falryn")).toBe(6);
  });

  test("counts a wide character as two cells", () => {
    // `.length` is 2 and the terminal draws 4 columns. Laying this out by
    // length is what draws a box that does not close.
    expect("日本".length).toBe(2);
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("ｆｕｌｌ")).toBe(8);
    expect(displayWidth("한글")).toBe(4);
  });

  test("counts an emoji as two cells", () => {
    expect(displayWidth("🚀")).toBe(2);
  });

  test("counts a combining mark as nothing", () => {
    // "e" plus U+0301 draws one cell, not two.
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("é")).toBe(1);
  });

  test("counts a zero-width character as nothing", () => {
    expect(displayWidth("a​b")).toBe(2);
    expect(displayWidth("﻿")).toBe(0);
  });

  test("counts a control character as nothing, having no cell to draw in", () => {
    expect(displayWidth("\u001b[31m")).toBe(4);
  });
});

describe("sanitizing untrusted text", () => {
  test("leaves ordinary text alone", () => {
    expect(sanitizeTerminalText("/Users/x/.config/falryn.jsonc")).toBe(
      "/Users/x/.config/falryn.jsonc",
    );
    expect(sanitizeTerminalText("日本 🚀 é")).toBe("日本 🚀 é");
  });

  test("neutralizes the escape character, so no ANSI survives", () => {
    // The injection boundary. A value from a configuration file carrying this
    // must render as characters rather than clear the screen.
    expect(sanitizeTerminalText("\u001b[2J\u001b[H")).toBe("\\x1b[2J\\x1b[H");
    expect(sanitizeTerminalText("\u001b[2J")).not.toContain("\u001b");
  });

  test("escapes newlines and tabs, so a value cannot forge a line", () => {
    expect(sanitizeTerminalText("a\nb\tc\r")).toBe("a\\x0ab\\x09c\\x0d");
  });

  test("escapes C1 controls and DEL", () => {
    expect(sanitizeTerminalText("\u007f\u0085\u009b")).toBe("\\x7f\\x85\\x9b");
  });

  test("escapes a lone surrogate and keeps a paired one", () => {
    expect(sanitizeTerminalText("\ud800")).toBe("\\ud800");
    expect(sanitizeTerminalText("\udfff")).toBe("\\udfff");
    // A well-formed pair is one character and survives untouched.
    expect(sanitizeTerminalText("🚀")).toBe("🚀");
  });

  test("produces text that measures and wraps without a control in it", () => {
    const sanitized = sanitizeTerminalText("\u001b[31mred\u001b[0m\nnext");
    expect(holdsControl(sanitized)).toBe(false);
    expect(wrapToWidth(sanitized, 80)).toHaveLength(1);
  });
});

describe("truncating to a width", () => {
  test("returns text that already fits", () => {
    expect(truncateToWidth("falryn", 10, "…")).toBe("falryn");
    expect(truncateToWidth("falryn", 6, "…")).toBe("falryn");
  });

  test("shortens and marks text that does not", () => {
    expect(truncateToWidth("falryn", 4, "…")).toBe("fal…");
    expect(truncateToWidth("falryn", 4, "...")).toBe("f...");
  });

  test("never exceeds the width it was given, wide characters included", () => {
    // Cutting between the two cells of a wide character is what makes a
    // fixed-width column overflow by one.
    expect(displayWidth(truncateToWidth("日本語です", 5, "…"))).toBeLessThanOrEqual(5);
    expect(truncateToWidth("日本語です", 5, "…")).toBe("日本…");
  });

  test("drops a marker that does not itself fit", () => {
    expect(truncateToWidth("falryn", 2, "...")).toBe("fa");
  });

  test("answers a zero, a negative, and a fractional width", () => {
    expect(truncateToWidth("falryn", 0, "…")).toBe("");
    expect(truncateToWidth("falryn", -5, "…")).toBe("");
    expect(truncateToWidth("falryn", 4.9, "…")).toBe("fal…");
  });
});

describe("wrapping to a width", () => {
  test("breaks at spaces", () => {
    expect(wrapToWidth("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  test("keeps existing newlines as paragraph breaks", () => {
    expect(wrapToWidth("one\n\ntwo", 10)).toEqual(["one", "", "two"]);
  });

  test("splits a word wider than the line rather than overflowing", () => {
    expect(wrapToWidth("supercalifragilistic", 6)).toEqual(["superc", "alifra", "gilist", "ic"]);
  });

  test("wraps by display width, not by length", () => {
    for (const line of wrapToWidth("日本語ですこんにちは", 6)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(6);
    }
  });

  test("terminates on a width of one, zero, a negative, and a NaN", () => {
    // A pure function handed an unusable width has to clamp. The failure this
    // guards is a loop that never makes progress.
    expect(wrapToWidth("ab", 1)).toEqual(["a", "b"]);
    expect(wrapToWidth("ab", 0)).toEqual(["a", "b"]);
    expect(wrapToWidth("ab", -3)).toEqual(["a", "b"]);
    expect(wrapToWidth("ab", Number.NaN)).toEqual(["ab"]);
  });

  test("gives a character wider than the line its own line rather than dropping it", () => {
    expect(wrapToWidth("日本", 1)).toEqual(["日", "本"]);
  });

  test("bounds an absurd width rather than believing it", () => {
    expect(wrapToWidth("falryn", Number.POSITIVE_INFINITY)).toEqual(["falryn"]);
    expect(MAX_DISPLAY_WIDTH).toBeGreaterThan(0);
  });

  test("loses no text", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(wrapToWidth(text, 12).join(" ")).toBe(text);
  });
});
